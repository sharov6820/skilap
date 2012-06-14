var async = require('async');
var _ = require('underscore');
var extend = require('node.extend');

module.exports.getAccountRegister = function (token,accId, offset, limit, cb ) {
	var self = this;
	async.series ([
		function (cb1) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb1);
		}, 
		function (cb1) {
			var accStats = self._stats[accId];
			if (limit==null) {
				if (offset==0 || offset == null)
					process.nextTick(function () { cb1(null, accStats.trDateIndex); });
				else
					process.nextTick(function () { cb1(null, accStats.trDateIndex.slice(offset, offset + limit)); });
			} else
				process.nextTick(function () { cb1(null, accStats.trDateIndex.slice(offset, offset + limit)); });
		}], function (err, results) {
			if (err) return cb(err);
			cb(null,results[1]);
		}
	)
}

module.exports.getTransaction = function (token, trId, cb) {
	var self = this;
	async.series ([
		function (cb1) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb1);
		}, 
		function (cb1) {
			self._cash_transactions.get(trId, cb1);
		}
	], function (err, results) {
		if (err) return cb(err);
		cb(null,results[1]);
	})
}

module.exports.saveTransaction = function (token,tr,leadAccId,cb) {
	var debug = false;
	if (debug) { console.log("Received"); console.log(arguments); }
	if (_.isFunction(leadAccId)) {
		cb = leadAccId;
		leadAccId = null;
	}
	var self = this;
	var trn={};
	var leadAcc = null;
	async.series ([
		// wait for data lock
		function (cb) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb);
		}, 
		// get lead account, if any
		function (cb) {
			if (leadAccId==null) return cb();
			self.getAccount(token,leadAccId,function(err,acc) {
				if (err) return cb(err);
				leadAcc = acc;
				cb(null);
			});
		},
		// fix current user id
		function (cb) {
			self._coreapi.getUser(token,function (err, user) {
				if (err) return cb(err);
				tr.uid = user.id;
				cb()
			})
		},				
		// sync with existing transaction or get new id for insert
		// detect also split modify status
		function (cb) {				
			if (debug) { console.log("Before sync on update"); console.log(tr); }			
			if (tr.id) {
				self._cash_transactions.get(tr.id,function (err, tr_) {
					if (err) return cb(err);
					// get all the missing properties from existing transaction except splits
					var fprops = _.without(_(tr_).keys(),"splits");
					var ftr = _.pick(tr_,fprops);
					trn = _(tr).defaults(ftr);
					// now we have to adjust splits
					_(trn.splits).forEach(function (split) {
						split.isModified = true;
						split.isNew = true;						
						var oldSplit = _(tr_.splits).find(function (split2) { return split2.id==split.id; });
						if (!oldSplit) return;
						split.isNew = false;
						// if both new values are defined and not the same as previous nothing to do
						if (!_.isUndefined(split.value) && split.value!= oldSplit.value && !_.isUndefined(split.quantity) && split.quantity != oldSplit.quantity) 
							return; // changed both split and quantity, nothing to do
						if (!_.isUndefined(split.value) && split.value != oldSplit.value) {
							// changed value, adjust quantity
							var part = oldSplit.value/split.value;
							if (part==0) {
								if (!_.isUndefined(split.quantity))
									delete split.quantity;
							}
							else {
								split.quantity = oldSplit.quantity/part;
							}
						} else if (!_.isUndefined(split.quantity) && split.quantity != oldSplit.quantity) {
							// changed quantity, adjust value
							var part = oldSplit.quantity/split.quantity;
							if (part==0){
								if (!_.isUndefined(split.value))
									delete split.value;
							}
							else {
								split.value = oldSplit.value/part;
							}
						} else
							split.isModified = false;
					})
					cb()
				});		
			} else {
				self._ctx.getUniqueId(function (err, id) {
					if (err) return cb(err);
					trn=tr;
					trn.id = id;
					cb()
				})
			}
		}, 
		// ensue that transaction has currency, this is required
		function (cb) {
			if (trn.currency) return cb(); 
			if (!trn.currency && !(leadAcc && leadAcc.cmdty.space=="ISO4217") )
				return cb(new Error("Transaction should have base currency"));
			trn.currency=_(leadAcc.cmdty).clone();
			cb();
		},
		// ensure that slits has valid quantity and values
		function (cb) {
			if (debug) { console.log("Before value quantity restore"); console.log(trn); }
			async.forEachSeries(trn.splits,function(spl,cb) {
				// with lead account we can use conversion
				self.getAccount(token,spl.accountId,function(err,splitAccount){
					if(err) return cb(err);
					// if split cmdty equals to transaction currency then both value
					// and quantity should be the same, value takes preference
					if (_(splitAccount.cmdty).isEqual(trn.currency)) {
						var val = 0;
						if (!_.isUndefined(spl.value))
							val = spl.value;
						else if (!_.isUndefined(spl.quantity))
							val = spl.quantity;
						spl.value = spl.quantity = val;
						return cb();
					}
					
					// if split cmdty not equal to trn currency and both values defined, nothing to do 
					if (!_.isUndefined(spl.value) && !_.isUndefined(spl.quantity)){
						var rate = (spl.quantity/spl.value).toFixed(5);
						price = {cmdty:trn.currency,currency:splitAccount.cmdty,date:trn.dateEntered,value:rate,source:"transaction"};
						self.savePrice(token,price,function(err,pricen){
							console.log('after save price');
							console.log(err);
							console.log(pricen);
							if(err)
								return cb(err);
							return cb();
						});					
					}
						
					// otherwise lets try to fill missing value
					var irate = 1;
					// value is known
					self.getCmdtyPrice(token,trn.currency,splitAccount.cmdty,null,null,function(err,rate){
						if(err && !(err.skilap && err.skilap.subject == "UnknownRate"))
							return cb(err);

						if (!err && rate!=0) 
							irate = rate;

						// depending on which part are known, restore another part
						if (spl.value)
							spl.quantity = spl.value*irate;
						else
							spl.value = spl.quantity/irate;
							
						cb()
					})
				})
			}, function (err) {
				cb(err);
			})
		},
		// avoid dis-balance
		function (cb) {
			if (debug) { console.log("Before dis-balance"); console.log(trn); }
			// check what we have
			var value=0; var leadSplit = false; var nonEditedSplit = false;
			_(trn.splits).forEach(function (split) {
				if (leadAcc && split.accountId==leadAcc.id)
					leadSplit = split;
				if (split.isModified==false)
					nonEditedSplit = split;
				value+=split.value;
			})
			// simplest, put dis-ballance to missing lead split
			if (leadAcc && !leadSplit) {
				self._ctx.getUniqueId(function (err, id) {
					if (err) return cb(err);
					trn.splits.push({value:-1*value,quantity:-1*value,accountId:leadAcc.id,id:id,description:""});
					cb()
				})
			}  // when we have two splits we can compensate thru non modified one
			else if (trn.splits.length==2 && nonEditedSplit ) {
				var newVal = nonEditedSplit.value-value;
				if (newVal==0) {
					nonEditedSplit.value = leadSplit.quantity = 0;
				} else {
					var part = nonEditedSplit.value/newVal;
					if (part==0) part = 1;
					nonEditedSplit.value=newVal;					
					nonEditedSplit.quantity/=part;
				}
				cb();
			} else {
				if (value==0) return cb();
				self.getSpecialAccount(token,"disballance",trn.currency, function (err, acc) {
					if (err) return cb(err);
					self._ctx.getUniqueId(function (err, id) {
						if (err) return cb(err);
						trn.splits.push({value:-1*value,quantity:-1*value,accountId:acc.id,id:id,description:""});
						cb()
					})
				})
			}
		},
		// collapse splits of same accounts
		function (cb) {		
			if (debug) { console.log("Before collapse"); console.log(trn); }
			var newSplits = [];
			var mgroups = {};
			// reduce all splits to reducable groups (same accountId+description)
			_(trn.splits).reduce(function (ctx, value) {
				var key = "_"+value.accountId+value.description;
				key = key.replace(/^\s*|\s*$/g, ''); // trim
				if (!ctx[key])
					ctx[key]=[];
				ctx[key].push(value);
				return ctx;
			},mgroups);
			// merge reducable groups
			_.forEach(_(mgroups).values(), function (splits) {
				var newSplit = _(splits[0]).clone();
				for (var i=1; i<splits.length; i++) {
					var e = splits[i];
					newSplit.value+=e.value;
					newSplit.quantity+=e.quantity;
				}
				newSplits.push(newSplit);
			})
			// filter splits with zero values
			var meaningSplits = _(newSplits).filter(function (s) { return s.value!=0; })
			// check if we have some splits at the end, if not restore split from leading account
			// when possible
			if (meaningSplits.length==0 && leadAcc) {
				var lSplit = _(newSplits).find(function (s) {return s.id = leadAcc.id} );
				if (lSplit)	meaningSplits.push(lSplit);
			}
			trn.splits = meaningSplits;
			cb();
		},
		// obtain ids for new splits
		function (cb) {
			if (debug) { console.log("Before split ids"); console.log(trn);	}
			async.forEachSeries(trn.splits,function(split,cb){
				if(split.id) return cb();
				self._ctx.getUniqueId(function (err, id) {
					if (err) return cb(err);
					split.id = id;
					cb();
				});
			},cb);
		},
		// final verification 
		function (cb) {
			if (!(_.isArray(trn.splits) && trn.splits.length>0))
				return cb(new Error("Transaction should have splits"));
			if (!(_.isObject(trn.currency)))
				return cb(new Error("Transaction should have currency"));
			if (_.isUndefined(trn.id))
				return cb(new Error("Transaction should have id"));
			if (!(_.isDate(trn.datePosted) || !_.isNaN(Date.parse(trn.datePosted))))
				return cb(new Error("Transaction should have date posted"));
			if (!(_.isDate(trn.dateEntered) || !_.isNaN(Date.parse(trn.dateEntered))))
				return cb(new Error("Transaction should have date entered"));
			// check splits
			var fails = _(trn.splits).find(function (s) {
				if (_.isUndefined(s.id)) {
					cb(new Error("Every split should have an id"));
					return true;
				}
				if (_.isUndefined(s.value)) {
					cb(new Error("Every split should have value"));
					return true;
				}					
				if (_.isUndefined(s.quantity)) {
					cb(new Error("Every split should have quantity"));
					return true;
				}					
				if (_.isUndefined(s.accountId)) {
					cb(new Error("Every split should have accountId"));
					return true;
				}					
			})
			if (!fails)
				cb()
		},
		// sanify transaction
		function (cb) {
			var str = _(trn).pick(["id","datePosted","dateEntered","currency","splits","description","num"]);
			for (var i=0; i<str.splits.length; i++) {
				var split = _(str.splits[i]).pick("id","value","quantity","rstate","description","accountId","num");
				str.splits[i]= split;
			}
			trn = str;
			cb();
		},
		// finally save or update
		function(cb){
			if (debug) { console.log("Before save"); console.log(trn);	}			
			self._cash_transactions.put(trn.id, trn, cb);
		}			
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {});
		cb(null);
	})
}

module.exports.getTransactionInDateRange = function (token, range, cb) {
	var self = this;
	var res = [];
	async.series([
		function start(cb1) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.view"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb1);
		}, 
		function (cb1) {
			var stream = self._cash_transactions.find({datePosted: {$range: [range[0].valueOf(),range[1].valueOf(),range[2],range[3]]}}).stream();
			stream.on('record', function (key,tr) {
				res.push(tr);
			});
			stream.on('end',cb1);
			stream.on('error',cb1);
		}],
		function done (err) {
			if (err) console.log(err);
			process.nextTick(function () {
				cb(err, res);
			});
		}
	);
}

module.exports.clearTransactions = function (token, ids, cb) {
	var self = this;
	if (ids == null) {
		async.series ([
			function (cb1) {
				async.parallel([
					function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
					function (cb) { self._waitForData(cb) }
				],cb1);
			},
			function (cb1) {
				self._cash_transactions.clear(cb1);
			} 
		], function (err) {
			if (err) return cb(err);
			self._calcStats(function () {})
			cb(null);
		});
	} else {
		var trs = [];
		async.series ([
			function (cb1) {
				async.parallel([
					function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
					function (cb) { self._waitForData(cb) }
				],cb1);
			},
			function (cb1) {				
				async.forEach(ids,function(id,cb2){
					self._cash_transactions.get(id,function (err, tr) {
						if (err) return cb2(err);
						trs.push(tr);				
						process.nextTick(cb2);
					});		
				},cb1);				
			},
			function(cb1){
				async.forEach(trs, function (e,cb2) {					
					self._cash_transactions.put(e.id,null,cb2);
				},cb1);
			} 
		], function (err) {
			if (err) return cb(err);
			self._calcStats(function () {})
			cb(null);
		});
	}
}

module.exports.importTransactions = function (token, transactions, cb) {
	var self = this;
	var uid = null;
	async.series ([
		function (cb1) {
			async.parallel([
				function (cb) { self._coreapi.checkPerm(token,["cash.edit"],cb) },
				function (cb) { self._waitForData(cb) }
			],cb1);
		},
		function (cb) {
			self._coreapi.getUser(token,function (err, user) {
				if (err) return cb(err);
				uid = user.id;
				cb()
			})
		},					
		function (cb) {
			async.forEach(transactions, function (e,cb) {
				e.uid = uid;
				self._cash_transactions.put(e.id,e,cb);
			},cb);
		}, 
	], function (err) {
		if (err) return cb(err);
		self._calcStats(function () {})
		cb(null);
	})
}
