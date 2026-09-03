var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/fast-content-type-parse/index.js
var require_fast_content_type_parse = __commonJS({
  "node_modules/fast-content-type-parse/index.js"(exports, module) {
    "use strict";
    var NullObject = function NullObject2() {
    };
    NullObject.prototype = /* @__PURE__ */ Object.create(null);
    var paramRE = /; *([!#$%&'*+.^\w`|~-]+)=("(?:[\v\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\v\u0020-\u00ff])*"|[!#$%&'*+.^\w`|~-]+) */gu;
    var quotedPairRE = /\\([\v\u0020-\u00ff])/gu;
    var mediaTypeRE = /^[!#$%&'*+.^\w|~-]+\/[!#$%&'*+.^\w|~-]+$/u;
    var defaultContentType = { type: "", parameters: new NullObject() };
    Object.freeze(defaultContentType.parameters);
    Object.freeze(defaultContentType);
    function parse2(header) {
      if (typeof header !== "string") {
        throw new TypeError("argument header is required and must be a string");
      }
      let index = header.indexOf(";");
      const type = index !== -1 ? header.slice(0, index).trim() : header.trim();
      if (mediaTypeRE.test(type) === false) {
        throw new TypeError("invalid media type");
      }
      const result = {
        type: type.toLowerCase(),
        parameters: new NullObject()
      };
      if (index === -1) {
        return result;
      }
      let key;
      let match;
      let value;
      paramRE.lastIndex = index;
      while (match = paramRE.exec(header)) {
        if (match.index !== index) {
          throw new TypeError("invalid parameter format");
        }
        index += match[0].length;
        key = match[1].toLowerCase();
        value = match[2];
        if (value[0] === '"') {
          value = value.slice(1, value.length - 1);
          quotedPairRE.test(value) && (value = value.replace(quotedPairRE, "$1"));
        }
        result.parameters[key] = value;
      }
      if (index !== header.length) {
        throw new TypeError("invalid parameter format");
      }
      return result;
    }
    function safeParse2(header) {
      if (typeof header !== "string") {
        return defaultContentType;
      }
      let index = header.indexOf(";");
      const type = index !== -1 ? header.slice(0, index).trim() : header.trim();
      if (mediaTypeRE.test(type) === false) {
        return defaultContentType;
      }
      const result = {
        type: type.toLowerCase(),
        parameters: new NullObject()
      };
      if (index === -1) {
        return result;
      }
      let key;
      let match;
      let value;
      paramRE.lastIndex = index;
      while (match = paramRE.exec(header)) {
        if (match.index !== index) {
          return defaultContentType;
        }
        index += match[0].length;
        key = match[1].toLowerCase();
        value = match[2];
        if (value[0] === '"') {
          value = value.slice(1, value.length - 1);
          quotedPairRE.test(value) && (value = value.replace(quotedPairRE, "$1"));
        }
        result.parameters[key] = value;
      }
      if (index !== header.length) {
        return defaultContentType;
      }
      return result;
    }
    module.exports.default = { parse: parse2, safeParse: safeParse2 };
    module.exports.parse = parse2;
    module.exports.safeParse = safeParse2;
    module.exports.defaultContentType = defaultContentType;
  }
});

// node_modules/bottleneck/light.js
var require_light = __commonJS({
  "node_modules/bottleneck/light.js"(exports, module) {
    (function(global2, factory) {
      typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : global2.Bottleneck = factory();
    })(exports, (function() {
      "use strict";
      var commonjsGlobal = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
      function getCjsExportFromNamespace(n) {
        return n && n["default"] || n;
      }
      var load = function(received, defaults, onto = {}) {
        var k, ref, v;
        for (k in defaults) {
          v = defaults[k];
          onto[k] = (ref = received[k]) != null ? ref : v;
        }
        return onto;
      };
      var overwrite = function(received, defaults, onto = {}) {
        var k, v;
        for (k in received) {
          v = received[k];
          if (defaults[k] !== void 0) {
            onto[k] = v;
          }
        }
        return onto;
      };
      var parser = {
        load,
        overwrite
      };
      var DLList;
      DLList = class DLList {
        constructor(incr, decr) {
          this.incr = incr;
          this.decr = decr;
          this._first = null;
          this._last = null;
          this.length = 0;
        }
        push(value) {
          var node;
          this.length++;
          if (typeof this.incr === "function") {
            this.incr();
          }
          node = {
            value,
            prev: this._last,
            next: null
          };
          if (this._last != null) {
            this._last.next = node;
            this._last = node;
          } else {
            this._first = this._last = node;
          }
          return void 0;
        }
        shift() {
          var value;
          if (this._first == null) {
            return;
          } else {
            this.length--;
            if (typeof this.decr === "function") {
              this.decr();
            }
          }
          value = this._first.value;
          if ((this._first = this._first.next) != null) {
            this._first.prev = null;
          } else {
            this._last = null;
          }
          return value;
        }
        first() {
          if (this._first != null) {
            return this._first.value;
          }
        }
        getArray() {
          var node, ref, results;
          node = this._first;
          results = [];
          while (node != null) {
            results.push((ref = node, node = node.next, ref.value));
          }
          return results;
        }
        forEachShift(cb) {
          var node;
          node = this.shift();
          while (node != null) {
            cb(node), node = this.shift();
          }
          return void 0;
        }
        debug() {
          var node, ref, ref1, ref2, results;
          node = this._first;
          results = [];
          while (node != null) {
            results.push((ref = node, node = node.next, {
              value: ref.value,
              prev: (ref1 = ref.prev) != null ? ref1.value : void 0,
              next: (ref2 = ref.next) != null ? ref2.value : void 0
            }));
          }
          return results;
        }
      };
      var DLList_1 = DLList;
      var Events;
      Events = class Events {
        constructor(instance) {
          this.instance = instance;
          this._events = {};
          if (this.instance.on != null || this.instance.once != null || this.instance.removeAllListeners != null) {
            throw new Error("An Emitter already exists for this object");
          }
          this.instance.on = (name, cb) => {
            return this._addListener(name, "many", cb);
          };
          this.instance.once = (name, cb) => {
            return this._addListener(name, "once", cb);
          };
          this.instance.removeAllListeners = (name = null) => {
            if (name != null) {
              return delete this._events[name];
            } else {
              return this._events = {};
            }
          };
        }
        _addListener(name, status, cb) {
          var base;
          if ((base = this._events)[name] == null) {
            base[name] = [];
          }
          this._events[name].push({ cb, status });
          return this.instance;
        }
        listenerCount(name) {
          if (this._events[name] != null) {
            return this._events[name].length;
          } else {
            return 0;
          }
        }
        async trigger(name, ...args) {
          var e, promises;
          try {
            if (name !== "debug") {
              this.trigger("debug", `Event triggered: ${name}`, args);
            }
            if (this._events[name] == null) {
              return;
            }
            this._events[name] = this._events[name].filter(function(listener) {
              return listener.status !== "none";
            });
            promises = this._events[name].map(async (listener) => {
              var e2, returned;
              if (listener.status === "none") {
                return;
              }
              if (listener.status === "once") {
                listener.status = "none";
              }
              try {
                returned = typeof listener.cb === "function" ? listener.cb(...args) : void 0;
                if (typeof (returned != null ? returned.then : void 0) === "function") {
                  return await returned;
                } else {
                  return returned;
                }
              } catch (error) {
                e2 = error;
                {
                  this.trigger("error", e2);
                }
                return null;
              }
            });
            return (await Promise.all(promises)).find(function(x) {
              return x != null;
            });
          } catch (error) {
            e = error;
            {
              this.trigger("error", e);
            }
            return null;
          }
        }
      };
      var Events_1 = Events;
      var DLList$1, Events$1, Queues;
      DLList$1 = DLList_1;
      Events$1 = Events_1;
      Queues = class Queues {
        constructor(num_priorities) {
          var i;
          this.Events = new Events$1(this);
          this._length = 0;
          this._lists = (function() {
            var j, ref, results;
            results = [];
            for (i = j = 1, ref = num_priorities; 1 <= ref ? j <= ref : j >= ref; i = 1 <= ref ? ++j : --j) {
              results.push(new DLList$1((() => {
                return this.incr();
              }), (() => {
                return this.decr();
              })));
            }
            return results;
          }).call(this);
        }
        incr() {
          if (this._length++ === 0) {
            return this.Events.trigger("leftzero");
          }
        }
        decr() {
          if (--this._length === 0) {
            return this.Events.trigger("zero");
          }
        }
        push(job) {
          return this._lists[job.options.priority].push(job);
        }
        queued(priority) {
          if (priority != null) {
            return this._lists[priority].length;
          } else {
            return this._length;
          }
        }
        shiftAll(fn) {
          return this._lists.forEach(function(list) {
            return list.forEachShift(fn);
          });
        }
        getFirst(arr = this._lists) {
          var j, len, list;
          for (j = 0, len = arr.length; j < len; j++) {
            list = arr[j];
            if (list.length > 0) {
              return list;
            }
          }
          return [];
        }
        shiftLastFrom(priority) {
          return this.getFirst(this._lists.slice(priority).reverse()).shift();
        }
      };
      var Queues_1 = Queues;
      var BottleneckError;
      BottleneckError = class BottleneckError extends Error {
      };
      var BottleneckError_1 = BottleneckError;
      var BottleneckError$1, DEFAULT_PRIORITY, Job, NUM_PRIORITIES, parser$1;
      NUM_PRIORITIES = 10;
      DEFAULT_PRIORITY = 5;
      parser$1 = parser;
      BottleneckError$1 = BottleneckError_1;
      Job = class Job {
        constructor(task, args, options, jobDefaults, rejectOnDrop, Events2, _states, Promise2) {
          this.task = task;
          this.args = args;
          this.rejectOnDrop = rejectOnDrop;
          this.Events = Events2;
          this._states = _states;
          this.Promise = Promise2;
          this.options = parser$1.load(options, jobDefaults);
          this.options.priority = this._sanitizePriority(this.options.priority);
          if (this.options.id === jobDefaults.id) {
            this.options.id = `${this.options.id}-${this._randomIndex()}`;
          }
          this.promise = new this.Promise((_resolve, _reject) => {
            this._resolve = _resolve;
            this._reject = _reject;
          });
          this.retryCount = 0;
        }
        _sanitizePriority(priority) {
          var sProperty;
          sProperty = ~~priority !== priority ? DEFAULT_PRIORITY : priority;
          if (sProperty < 0) {
            return 0;
          } else if (sProperty > NUM_PRIORITIES - 1) {
            return NUM_PRIORITIES - 1;
          } else {
            return sProperty;
          }
        }
        _randomIndex() {
          return Math.random().toString(36).slice(2);
        }
        doDrop({ error, message = "This job has been dropped by Bottleneck" } = {}) {
          if (this._states.remove(this.options.id)) {
            if (this.rejectOnDrop) {
              this._reject(error != null ? error : new BottleneckError$1(message));
            }
            this.Events.trigger("dropped", { args: this.args, options: this.options, task: this.task, promise: this.promise });
            return true;
          } else {
            return false;
          }
        }
        _assertStatus(expected) {
          var status;
          status = this._states.jobStatus(this.options.id);
          if (!(status === expected || expected === "DONE" && status === null)) {
            throw new BottleneckError$1(`Invalid job status ${status}, expected ${expected}. Please open an issue at https://github.com/SGrondin/bottleneck/issues`);
          }
        }
        doReceive() {
          this._states.start(this.options.id);
          return this.Events.trigger("received", { args: this.args, options: this.options });
        }
        doQueue(reachedHWM, blocked) {
          this._assertStatus("RECEIVED");
          this._states.next(this.options.id);
          return this.Events.trigger("queued", { args: this.args, options: this.options, reachedHWM, blocked });
        }
        doRun() {
          if (this.retryCount === 0) {
            this._assertStatus("QUEUED");
            this._states.next(this.options.id);
          } else {
            this._assertStatus("EXECUTING");
          }
          return this.Events.trigger("scheduled", { args: this.args, options: this.options });
        }
        async doExecute(chained, clearGlobalState, run, free) {
          var error, eventInfo, passed;
          if (this.retryCount === 0) {
            this._assertStatus("RUNNING");
            this._states.next(this.options.id);
          } else {
            this._assertStatus("EXECUTING");
          }
          eventInfo = { args: this.args, options: this.options, retryCount: this.retryCount };
          this.Events.trigger("executing", eventInfo);
          try {
            passed = await (chained != null ? chained.schedule(this.options, this.task, ...this.args) : this.task(...this.args));
            if (clearGlobalState()) {
              this.doDone(eventInfo);
              await free(this.options, eventInfo);
              this._assertStatus("DONE");
              return this._resolve(passed);
            }
          } catch (error1) {
            error = error1;
            return this._onFailure(error, eventInfo, clearGlobalState, run, free);
          }
        }
        doExpire(clearGlobalState, run, free) {
          var error, eventInfo;
          if (this._states.jobStatus(this.options.id === "RUNNING")) {
            this._states.next(this.options.id);
          }
          this._assertStatus("EXECUTING");
          eventInfo = { args: this.args, options: this.options, retryCount: this.retryCount };
          error = new BottleneckError$1(`This job timed out after ${this.options.expiration} ms.`);
          return this._onFailure(error, eventInfo, clearGlobalState, run, free);
        }
        async _onFailure(error, eventInfo, clearGlobalState, run, free) {
          var retry2, retryAfter;
          if (clearGlobalState()) {
            retry2 = await this.Events.trigger("failed", error, eventInfo);
            if (retry2 != null) {
              retryAfter = ~~retry2;
              this.Events.trigger("retry", `Retrying ${this.options.id} after ${retryAfter} ms`, eventInfo);
              this.retryCount++;
              return run(retryAfter);
            } else {
              this.doDone(eventInfo);
              await free(this.options, eventInfo);
              this._assertStatus("DONE");
              return this._reject(error);
            }
          }
        }
        doDone(eventInfo) {
          this._assertStatus("EXECUTING");
          this._states.next(this.options.id);
          return this.Events.trigger("done", eventInfo);
        }
      };
      var Job_1 = Job;
      var BottleneckError$2, LocalDatastore, parser$2;
      parser$2 = parser;
      BottleneckError$2 = BottleneckError_1;
      LocalDatastore = class LocalDatastore {
        constructor(instance, storeOptions, storeInstanceOptions) {
          this.instance = instance;
          this.storeOptions = storeOptions;
          this.clientId = this.instance._randomIndex();
          parser$2.load(storeInstanceOptions, storeInstanceOptions, this);
          this._nextRequest = this._lastReservoirRefresh = this._lastReservoirIncrease = Date.now();
          this._running = 0;
          this._done = 0;
          this._unblockTime = 0;
          this.ready = this.Promise.resolve();
          this.clients = {};
          this._startHeartbeat();
        }
        _startHeartbeat() {
          var base;
          if (this.heartbeat == null && (this.storeOptions.reservoirRefreshInterval != null && this.storeOptions.reservoirRefreshAmount != null || this.storeOptions.reservoirIncreaseInterval != null && this.storeOptions.reservoirIncreaseAmount != null)) {
            return typeof (base = this.heartbeat = setInterval(() => {
              var amount, incr, maximum, now, reservoir;
              now = Date.now();
              if (this.storeOptions.reservoirRefreshInterval != null && now >= this._lastReservoirRefresh + this.storeOptions.reservoirRefreshInterval) {
                this._lastReservoirRefresh = now;
                this.storeOptions.reservoir = this.storeOptions.reservoirRefreshAmount;
                this.instance._drainAll(this.computeCapacity());
              }
              if (this.storeOptions.reservoirIncreaseInterval != null && now >= this._lastReservoirIncrease + this.storeOptions.reservoirIncreaseInterval) {
                ({
                  reservoirIncreaseAmount: amount,
                  reservoirIncreaseMaximum: maximum,
                  reservoir
                } = this.storeOptions);
                this._lastReservoirIncrease = now;
                incr = maximum != null ? Math.min(amount, maximum - reservoir) : amount;
                if (incr > 0) {
                  this.storeOptions.reservoir += incr;
                  return this.instance._drainAll(this.computeCapacity());
                }
              }
            }, this.heartbeatInterval)).unref === "function" ? base.unref() : void 0;
          } else {
            return clearInterval(this.heartbeat);
          }
        }
        async __publish__(message) {
          await this.yieldLoop();
          return this.instance.Events.trigger("message", message.toString());
        }
        async __disconnect__(flush) {
          await this.yieldLoop();
          clearInterval(this.heartbeat);
          return this.Promise.resolve();
        }
        yieldLoop(t = 0) {
          return new this.Promise(function(resolve, reject) {
            return setTimeout(resolve, t);
          });
        }
        computePenalty() {
          var ref;
          return (ref = this.storeOptions.penalty) != null ? ref : 15 * this.storeOptions.minTime || 5e3;
        }
        async __updateSettings__(options) {
          await this.yieldLoop();
          parser$2.overwrite(options, options, this.storeOptions);
          this._startHeartbeat();
          this.instance._drainAll(this.computeCapacity());
          return true;
        }
        async __running__() {
          await this.yieldLoop();
          return this._running;
        }
        async __queued__() {
          await this.yieldLoop();
          return this.instance.queued();
        }
        async __done__() {
          await this.yieldLoop();
          return this._done;
        }
        async __groupCheck__(time) {
          await this.yieldLoop();
          return this._nextRequest + this.timeout < time;
        }
        computeCapacity() {
          var maxConcurrent, reservoir;
          ({ maxConcurrent, reservoir } = this.storeOptions);
          if (maxConcurrent != null && reservoir != null) {
            return Math.min(maxConcurrent - this._running, reservoir);
          } else if (maxConcurrent != null) {
            return maxConcurrent - this._running;
          } else if (reservoir != null) {
            return reservoir;
          } else {
            return null;
          }
        }
        conditionsCheck(weight) {
          var capacity;
          capacity = this.computeCapacity();
          return capacity == null || weight <= capacity;
        }
        async __incrementReservoir__(incr) {
          var reservoir;
          await this.yieldLoop();
          reservoir = this.storeOptions.reservoir += incr;
          this.instance._drainAll(this.computeCapacity());
          return reservoir;
        }
        async __currentReservoir__() {
          await this.yieldLoop();
          return this.storeOptions.reservoir;
        }
        isBlocked(now) {
          return this._unblockTime >= now;
        }
        check(weight, now) {
          return this.conditionsCheck(weight) && this._nextRequest - now <= 0;
        }
        async __check__(weight) {
          var now;
          await this.yieldLoop();
          now = Date.now();
          return this.check(weight, now);
        }
        async __register__(index, weight, expiration) {
          var now, wait;
          await this.yieldLoop();
          now = Date.now();
          if (this.conditionsCheck(weight)) {
            this._running += weight;
            if (this.storeOptions.reservoir != null) {
              this.storeOptions.reservoir -= weight;
            }
            wait = Math.max(this._nextRequest - now, 0);
            this._nextRequest = now + wait + this.storeOptions.minTime;
            return {
              success: true,
              wait,
              reservoir: this.storeOptions.reservoir
            };
          } else {
            return {
              success: false
            };
          }
        }
        strategyIsBlock() {
          return this.storeOptions.strategy === 3;
        }
        async __submit__(queueLength, weight) {
          var blocked, now, reachedHWM;
          await this.yieldLoop();
          if (this.storeOptions.maxConcurrent != null && weight > this.storeOptions.maxConcurrent) {
            throw new BottleneckError$2(`Impossible to add a job having a weight of ${weight} to a limiter having a maxConcurrent setting of ${this.storeOptions.maxConcurrent}`);
          }
          now = Date.now();
          reachedHWM = this.storeOptions.highWater != null && queueLength === this.storeOptions.highWater && !this.check(weight, now);
          blocked = this.strategyIsBlock() && (reachedHWM || this.isBlocked(now));
          if (blocked) {
            this._unblockTime = now + this.computePenalty();
            this._nextRequest = this._unblockTime + this.storeOptions.minTime;
            this.instance._dropAllQueued();
          }
          return {
            reachedHWM,
            blocked,
            strategy: this.storeOptions.strategy
          };
        }
        async __free__(index, weight) {
          await this.yieldLoop();
          this._running -= weight;
          this._done += weight;
          this.instance._drainAll(this.computeCapacity());
          return {
            running: this._running
          };
        }
      };
      var LocalDatastore_1 = LocalDatastore;
      var BottleneckError$3, States;
      BottleneckError$3 = BottleneckError_1;
      States = class States {
        constructor(status1) {
          this.status = status1;
          this._jobs = {};
          this.counts = this.status.map(function() {
            return 0;
          });
        }
        next(id) {
          var current, next;
          current = this._jobs[id];
          next = current + 1;
          if (current != null && next < this.status.length) {
            this.counts[current]--;
            this.counts[next]++;
            return this._jobs[id]++;
          } else if (current != null) {
            this.counts[current]--;
            return delete this._jobs[id];
          }
        }
        start(id) {
          var initial;
          initial = 0;
          this._jobs[id] = initial;
          return this.counts[initial]++;
        }
        remove(id) {
          var current;
          current = this._jobs[id];
          if (current != null) {
            this.counts[current]--;
            delete this._jobs[id];
          }
          return current != null;
        }
        jobStatus(id) {
          var ref;
          return (ref = this.status[this._jobs[id]]) != null ? ref : null;
        }
        statusJobs(status) {
          var k, pos, ref, results, v;
          if (status != null) {
            pos = this.status.indexOf(status);
            if (pos < 0) {
              throw new BottleneckError$3(`status must be one of ${this.status.join(", ")}`);
            }
            ref = this._jobs;
            results = [];
            for (k in ref) {
              v = ref[k];
              if (v === pos) {
                results.push(k);
              }
            }
            return results;
          } else {
            return Object.keys(this._jobs);
          }
        }
        statusCounts() {
          return this.counts.reduce(((acc, v, i) => {
            acc[this.status[i]] = v;
            return acc;
          }), {});
        }
      };
      var States_1 = States;
      var DLList$2, Sync;
      DLList$2 = DLList_1;
      Sync = class Sync {
        constructor(name, Promise2) {
          this.schedule = this.schedule.bind(this);
          this.name = name;
          this.Promise = Promise2;
          this._running = 0;
          this._queue = new DLList$2();
        }
        isEmpty() {
          return this._queue.length === 0;
        }
        async _tryToRun() {
          var args, cb, error, reject, resolve, returned, task;
          if (this._running < 1 && this._queue.length > 0) {
            this._running++;
            ({ task, args, resolve, reject } = this._queue.shift());
            cb = await (async function() {
              try {
                returned = await task(...args);
                return function() {
                  return resolve(returned);
                };
              } catch (error1) {
                error = error1;
                return function() {
                  return reject(error);
                };
              }
            })();
            this._running--;
            this._tryToRun();
            return cb();
          }
        }
        schedule(task, ...args) {
          var promise, reject, resolve;
          resolve = reject = null;
          promise = new this.Promise(function(_resolve, _reject) {
            resolve = _resolve;
            return reject = _reject;
          });
          this._queue.push({ task, args, resolve, reject });
          this._tryToRun();
          return promise;
        }
      };
      var Sync_1 = Sync;
      var version = "2.19.5";
      var version$1 = {
        version
      };
      var version$2 = /* @__PURE__ */ Object.freeze({
        version,
        default: version$1
      });
      var require$$2 = () => console.log("You must import the full version of Bottleneck in order to use this feature.");
      var require$$3 = () => console.log("You must import the full version of Bottleneck in order to use this feature.");
      var require$$4 = () => console.log("You must import the full version of Bottleneck in order to use this feature.");
      var Events$2, Group, IORedisConnection$1, RedisConnection$1, Scripts$1, parser$3;
      parser$3 = parser;
      Events$2 = Events_1;
      RedisConnection$1 = require$$2;
      IORedisConnection$1 = require$$3;
      Scripts$1 = require$$4;
      Group = (function() {
        class Group2 {
          constructor(limiterOptions = {}) {
            this.deleteKey = this.deleteKey.bind(this);
            this.limiterOptions = limiterOptions;
            parser$3.load(this.limiterOptions, this.defaults, this);
            this.Events = new Events$2(this);
            this.instances = {};
            this.Bottleneck = Bottleneck_1;
            this._startAutoCleanup();
            this.sharedConnection = this.connection != null;
            if (this.connection == null) {
              if (this.limiterOptions.datastore === "redis") {
                this.connection = new RedisConnection$1(Object.assign({}, this.limiterOptions, { Events: this.Events }));
              } else if (this.limiterOptions.datastore === "ioredis") {
                this.connection = new IORedisConnection$1(Object.assign({}, this.limiterOptions, { Events: this.Events }));
              }
            }
          }
          key(key = "") {
            var ref;
            return (ref = this.instances[key]) != null ? ref : (() => {
              var limiter;
              limiter = this.instances[key] = new this.Bottleneck(Object.assign(this.limiterOptions, {
                id: `${this.id}-${key}`,
                timeout: this.timeout,
                connection: this.connection
              }));
              this.Events.trigger("created", limiter, key);
              return limiter;
            })();
          }
          async deleteKey(key = "") {
            var deleted, instance;
            instance = this.instances[key];
            if (this.connection) {
              deleted = await this.connection.__runCommand__(["del", ...Scripts$1.allKeys(`${this.id}-${key}`)]);
            }
            if (instance != null) {
              delete this.instances[key];
              await instance.disconnect();
            }
            return instance != null || deleted > 0;
          }
          limiters() {
            var k, ref, results, v;
            ref = this.instances;
            results = [];
            for (k in ref) {
              v = ref[k];
              results.push({
                key: k,
                limiter: v
              });
            }
            return results;
          }
          keys() {
            return Object.keys(this.instances);
          }
          async clusterKeys() {
            var cursor, end, found, i, k, keys, len, next, start;
            if (this.connection == null) {
              return this.Promise.resolve(this.keys());
            }
            keys = [];
            cursor = null;
            start = `b_${this.id}-`.length;
            end = "_settings".length;
            while (cursor !== 0) {
              [next, found] = await this.connection.__runCommand__(["scan", cursor != null ? cursor : 0, "match", `b_${this.id}-*_settings`, "count", 1e4]);
              cursor = ~~next;
              for (i = 0, len = found.length; i < len; i++) {
                k = found[i];
                keys.push(k.slice(start, -end));
              }
            }
            return keys;
          }
          _startAutoCleanup() {
            var base;
            clearInterval(this.interval);
            return typeof (base = this.interval = setInterval(async () => {
              var e, k, ref, results, time, v;
              time = Date.now();
              ref = this.instances;
              results = [];
              for (k in ref) {
                v = ref[k];
                try {
                  if (await v._store.__groupCheck__(time)) {
                    results.push(this.deleteKey(k));
                  } else {
                    results.push(void 0);
                  }
                } catch (error) {
                  e = error;
                  results.push(v.Events.trigger("error", e));
                }
              }
              return results;
            }, this.timeout / 2)).unref === "function" ? base.unref() : void 0;
          }
          updateSettings(options = {}) {
            parser$3.overwrite(options, this.defaults, this);
            parser$3.overwrite(options, options, this.limiterOptions);
            if (options.timeout != null) {
              return this._startAutoCleanup();
            }
          }
          disconnect(flush = true) {
            var ref;
            if (!this.sharedConnection) {
              return (ref = this.connection) != null ? ref.disconnect(flush) : void 0;
            }
          }
        }
        Group2.prototype.defaults = {
          timeout: 1e3 * 60 * 5,
          connection: null,
          Promise,
          id: "group-key"
        };
        return Group2;
      }).call(commonjsGlobal);
      var Group_1 = Group;
      var Batcher, Events$3, parser$4;
      parser$4 = parser;
      Events$3 = Events_1;
      Batcher = (function() {
        class Batcher2 {
          constructor(options = {}) {
            this.options = options;
            parser$4.load(this.options, this.defaults, this);
            this.Events = new Events$3(this);
            this._arr = [];
            this._resetPromise();
            this._lastFlush = Date.now();
          }
          _resetPromise() {
            return this._promise = new this.Promise((res, rej) => {
              return this._resolve = res;
            });
          }
          _flush() {
            clearTimeout(this._timeout);
            this._lastFlush = Date.now();
            this._resolve();
            this.Events.trigger("batch", this._arr);
            this._arr = [];
            return this._resetPromise();
          }
          add(data) {
            var ret;
            this._arr.push(data);
            ret = this._promise;
            if (this._arr.length === this.maxSize) {
              this._flush();
            } else if (this.maxTime != null && this._arr.length === 1) {
              this._timeout = setTimeout(() => {
                return this._flush();
              }, this.maxTime);
            }
            return ret;
          }
        }
        Batcher2.prototype.defaults = {
          maxTime: null,
          maxSize: null,
          Promise
        };
        return Batcher2;
      }).call(commonjsGlobal);
      var Batcher_1 = Batcher;
      var require$$4$1 = () => console.log("You must import the full version of Bottleneck in order to use this feature.");
      var require$$8 = getCjsExportFromNamespace(version$2);
      var Bottleneck2, DEFAULT_PRIORITY$1, Events$4, Job$1, LocalDatastore$1, NUM_PRIORITIES$1, Queues$1, RedisDatastore$1, States$1, Sync$1, parser$5, splice = [].splice;
      NUM_PRIORITIES$1 = 10;
      DEFAULT_PRIORITY$1 = 5;
      parser$5 = parser;
      Queues$1 = Queues_1;
      Job$1 = Job_1;
      LocalDatastore$1 = LocalDatastore_1;
      RedisDatastore$1 = require$$4$1;
      Events$4 = Events_1;
      States$1 = States_1;
      Sync$1 = Sync_1;
      Bottleneck2 = (function() {
        class Bottleneck3 {
          constructor(options = {}, ...invalid) {
            var storeInstanceOptions, storeOptions;
            this._addToQueue = this._addToQueue.bind(this);
            this._validateOptions(options, invalid);
            parser$5.load(options, this.instanceDefaults, this);
            this._queues = new Queues$1(NUM_PRIORITIES$1);
            this._scheduled = {};
            this._states = new States$1(["RECEIVED", "QUEUED", "RUNNING", "EXECUTING"].concat(this.trackDoneStatus ? ["DONE"] : []));
            this._limiter = null;
            this.Events = new Events$4(this);
            this._submitLock = new Sync$1("submit", this.Promise);
            this._registerLock = new Sync$1("register", this.Promise);
            storeOptions = parser$5.load(options, this.storeDefaults, {});
            this._store = (function() {
              if (this.datastore === "redis" || this.datastore === "ioredis" || this.connection != null) {
                storeInstanceOptions = parser$5.load(options, this.redisStoreDefaults, {});
                return new RedisDatastore$1(this, storeOptions, storeInstanceOptions);
              } else if (this.datastore === "local") {
                storeInstanceOptions = parser$5.load(options, this.localStoreDefaults, {});
                return new LocalDatastore$1(this, storeOptions, storeInstanceOptions);
              } else {
                throw new Bottleneck3.prototype.BottleneckError(`Invalid datastore type: ${this.datastore}`);
              }
            }).call(this);
            this._queues.on("leftzero", () => {
              var ref;
              return (ref = this._store.heartbeat) != null ? typeof ref.ref === "function" ? ref.ref() : void 0 : void 0;
            });
            this._queues.on("zero", () => {
              var ref;
              return (ref = this._store.heartbeat) != null ? typeof ref.unref === "function" ? ref.unref() : void 0 : void 0;
            });
          }
          _validateOptions(options, invalid) {
            if (!(options != null && typeof options === "object" && invalid.length === 0)) {
              throw new Bottleneck3.prototype.BottleneckError("Bottleneck v2 takes a single object argument. Refer to https://github.com/SGrondin/bottleneck#upgrading-to-v2 if you're upgrading from Bottleneck v1.");
            }
          }
          ready() {
            return this._store.ready;
          }
          clients() {
            return this._store.clients;
          }
          channel() {
            return `b_${this.id}`;
          }
          channel_client() {
            return `b_${this.id}_${this._store.clientId}`;
          }
          publish(message) {
            return this._store.__publish__(message);
          }
          disconnect(flush = true) {
            return this._store.__disconnect__(flush);
          }
          chain(_limiter) {
            this._limiter = _limiter;
            return this;
          }
          queued(priority) {
            return this._queues.queued(priority);
          }
          clusterQueued() {
            return this._store.__queued__();
          }
          empty() {
            return this.queued() === 0 && this._submitLock.isEmpty();
          }
          running() {
            return this._store.__running__();
          }
          done() {
            return this._store.__done__();
          }
          jobStatus(id) {
            return this._states.jobStatus(id);
          }
          jobs(status) {
            return this._states.statusJobs(status);
          }
          counts() {
            return this._states.statusCounts();
          }
          _randomIndex() {
            return Math.random().toString(36).slice(2);
          }
          check(weight = 1) {
            return this._store.__check__(weight);
          }
          _clearGlobalState(index) {
            if (this._scheduled[index] != null) {
              clearTimeout(this._scheduled[index].expiration);
              delete this._scheduled[index];
              return true;
            } else {
              return false;
            }
          }
          async _free(index, job, options, eventInfo) {
            var e, running;
            try {
              ({ running } = await this._store.__free__(index, options.weight));
              this.Events.trigger("debug", `Freed ${options.id}`, eventInfo);
              if (running === 0 && this.empty()) {
                return this.Events.trigger("idle");
              }
            } catch (error1) {
              e = error1;
              return this.Events.trigger("error", e);
            }
          }
          _run(index, job, wait) {
            var clearGlobalState, free, run;
            job.doRun();
            clearGlobalState = this._clearGlobalState.bind(this, index);
            run = this._run.bind(this, index, job);
            free = this._free.bind(this, index, job);
            return this._scheduled[index] = {
              timeout: setTimeout(() => {
                return job.doExecute(this._limiter, clearGlobalState, run, free);
              }, wait),
              expiration: job.options.expiration != null ? setTimeout(function() {
                return job.doExpire(clearGlobalState, run, free);
              }, wait + job.options.expiration) : void 0,
              job
            };
          }
          _drainOne(capacity) {
            return this._registerLock.schedule(() => {
              var args, index, next, options, queue;
              if (this.queued() === 0) {
                return this.Promise.resolve(null);
              }
              queue = this._queues.getFirst();
              ({ options, args } = next = queue.first());
              if (capacity != null && options.weight > capacity) {
                return this.Promise.resolve(null);
              }
              this.Events.trigger("debug", `Draining ${options.id}`, { args, options });
              index = this._randomIndex();
              return this._store.__register__(index, options.weight, options.expiration).then(({ success, wait, reservoir }) => {
                var empty;
                this.Events.trigger("debug", `Drained ${options.id}`, { success, args, options });
                if (success) {
                  queue.shift();
                  empty = this.empty();
                  if (empty) {
                    this.Events.trigger("empty");
                  }
                  if (reservoir === 0) {
                    this.Events.trigger("depleted", empty);
                  }
                  this._run(index, next, wait);
                  return this.Promise.resolve(options.weight);
                } else {
                  return this.Promise.resolve(null);
                }
              });
            });
          }
          _drainAll(capacity, total = 0) {
            return this._drainOne(capacity).then((drained) => {
              var newCapacity;
              if (drained != null) {
                newCapacity = capacity != null ? capacity - drained : capacity;
                return this._drainAll(newCapacity, total + drained);
              } else {
                return this.Promise.resolve(total);
              }
            }).catch((e) => {
              return this.Events.trigger("error", e);
            });
          }
          _dropAllQueued(message) {
            return this._queues.shiftAll(function(job) {
              return job.doDrop({ message });
            });
          }
          stop(options = {}) {
            var done, waitForExecuting;
            options = parser$5.load(options, this.stopDefaults);
            waitForExecuting = (at) => {
              var finished;
              finished = () => {
                var counts2;
                counts2 = this._states.counts;
                return counts2[0] + counts2[1] + counts2[2] + counts2[3] === at;
              };
              return new this.Promise((resolve, reject) => {
                if (finished()) {
                  return resolve();
                } else {
                  return this.on("done", () => {
                    if (finished()) {
                      this.removeAllListeners("done");
                      return resolve();
                    }
                  });
                }
              });
            };
            done = options.dropWaitingJobs ? (this._run = function(index, next) {
              return next.doDrop({
                message: options.dropErrorMessage
              });
            }, this._drainOne = () => {
              return this.Promise.resolve(null);
            }, this._registerLock.schedule(() => {
              return this._submitLock.schedule(() => {
                var k, ref, v;
                ref = this._scheduled;
                for (k in ref) {
                  v = ref[k];
                  if (this.jobStatus(v.job.options.id) === "RUNNING") {
                    clearTimeout(v.timeout);
                    clearTimeout(v.expiration);
                    v.job.doDrop({
                      message: options.dropErrorMessage
                    });
                  }
                }
                this._dropAllQueued(options.dropErrorMessage);
                return waitForExecuting(0);
              });
            })) : this.schedule({
              priority: NUM_PRIORITIES$1 - 1,
              weight: 0
            }, () => {
              return waitForExecuting(1);
            });
            this._receive = function(job) {
              return job._reject(new Bottleneck3.prototype.BottleneckError(options.enqueueErrorMessage));
            };
            this.stop = () => {
              return this.Promise.reject(new Bottleneck3.prototype.BottleneckError("stop() has already been called"));
            };
            return done;
          }
          async _addToQueue(job) {
            var args, blocked, error, options, reachedHWM, shifted, strategy;
            ({ args, options } = job);
            try {
              ({ reachedHWM, blocked, strategy } = await this._store.__submit__(this.queued(), options.weight));
            } catch (error1) {
              error = error1;
              this.Events.trigger("debug", `Could not queue ${options.id}`, { args, options, error });
              job.doDrop({ error });
              return false;
            }
            if (blocked) {
              job.doDrop();
              return true;
            } else if (reachedHWM) {
              shifted = strategy === Bottleneck3.prototype.strategy.LEAK ? this._queues.shiftLastFrom(options.priority) : strategy === Bottleneck3.prototype.strategy.OVERFLOW_PRIORITY ? this._queues.shiftLastFrom(options.priority + 1) : strategy === Bottleneck3.prototype.strategy.OVERFLOW ? job : void 0;
              if (shifted != null) {
                shifted.doDrop();
              }
              if (shifted == null || strategy === Bottleneck3.prototype.strategy.OVERFLOW) {
                if (shifted == null) {
                  job.doDrop();
                }
                return reachedHWM;
              }
            }
            job.doQueue(reachedHWM, blocked);
            this._queues.push(job);
            await this._drainAll();
            return reachedHWM;
          }
          _receive(job) {
            if (this._states.jobStatus(job.options.id) != null) {
              job._reject(new Bottleneck3.prototype.BottleneckError(`A job with the same id already exists (id=${job.options.id})`));
              return false;
            } else {
              job.doReceive();
              return this._submitLock.schedule(this._addToQueue, job);
            }
          }
          submit(...args) {
            var cb, fn, job, options, ref, ref1, task;
            if (typeof args[0] === "function") {
              ref = args, [fn, ...args] = ref, [cb] = splice.call(args, -1);
              options = parser$5.load({}, this.jobDefaults);
            } else {
              ref1 = args, [options, fn, ...args] = ref1, [cb] = splice.call(args, -1);
              options = parser$5.load(options, this.jobDefaults);
            }
            task = (...args2) => {
              return new this.Promise(function(resolve, reject) {
                return fn(...args2, function(...args3) {
                  return (args3[0] != null ? reject : resolve)(args3);
                });
              });
            };
            job = new Job$1(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
            job.promise.then(function(args2) {
              return typeof cb === "function" ? cb(...args2) : void 0;
            }).catch(function(args2) {
              if (Array.isArray(args2)) {
                return typeof cb === "function" ? cb(...args2) : void 0;
              } else {
                return typeof cb === "function" ? cb(args2) : void 0;
              }
            });
            return this._receive(job);
          }
          schedule(...args) {
            var job, options, task;
            if (typeof args[0] === "function") {
              [task, ...args] = args;
              options = {};
            } else {
              [options, task, ...args] = args;
            }
            job = new Job$1(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
            this._receive(job);
            return job.promise;
          }
          wrap(fn) {
            var schedule, wrapped;
            schedule = this.schedule.bind(this);
            wrapped = function(...args) {
              return schedule(fn.bind(this), ...args);
            };
            wrapped.withOptions = function(options, ...args) {
              return schedule(options, fn, ...args);
            };
            return wrapped;
          }
          async updateSettings(options = {}) {
            await this._store.__updateSettings__(parser$5.overwrite(options, this.storeDefaults));
            parser$5.overwrite(options, this.instanceDefaults, this);
            return this;
          }
          currentReservoir() {
            return this._store.__currentReservoir__();
          }
          incrementReservoir(incr = 0) {
            return this._store.__incrementReservoir__(incr);
          }
        }
        Bottleneck3.default = Bottleneck3;
        Bottleneck3.Events = Events$4;
        Bottleneck3.version = Bottleneck3.prototype.version = require$$8.version;
        Bottleneck3.strategy = Bottleneck3.prototype.strategy = {
          LEAK: 1,
          OVERFLOW: 2,
          OVERFLOW_PRIORITY: 4,
          BLOCK: 3
        };
        Bottleneck3.BottleneckError = Bottleneck3.prototype.BottleneckError = BottleneckError_1;
        Bottleneck3.Group = Bottleneck3.prototype.Group = Group_1;
        Bottleneck3.RedisConnection = Bottleneck3.prototype.RedisConnection = require$$2;
        Bottleneck3.IORedisConnection = Bottleneck3.prototype.IORedisConnection = require$$3;
        Bottleneck3.Batcher = Bottleneck3.prototype.Batcher = Batcher_1;
        Bottleneck3.prototype.jobDefaults = {
          priority: DEFAULT_PRIORITY$1,
          weight: 1,
          expiration: null,
          id: "<no-id>"
        };
        Bottleneck3.prototype.storeDefaults = {
          maxConcurrent: null,
          minTime: 0,
          highWater: null,
          strategy: Bottleneck3.prototype.strategy.LEAK,
          penalty: null,
          reservoir: null,
          reservoirRefreshInterval: null,
          reservoirRefreshAmount: null,
          reservoirIncreaseInterval: null,
          reservoirIncreaseAmount: null,
          reservoirIncreaseMaximum: null
        };
        Bottleneck3.prototype.localStoreDefaults = {
          Promise,
          timeout: null,
          heartbeatInterval: 250
        };
        Bottleneck3.prototype.redisStoreDefaults = {
          Promise,
          timeout: null,
          heartbeatInterval: 5e3,
          clientTimeout: 1e4,
          Redis: null,
          clientOptions: {},
          clusterNodes: null,
          clearDatastore: false,
          connection: null
        };
        Bottleneck3.prototype.instanceDefaults = {
          datastore: "local",
          connection: null,
          id: "<no-id>",
          rejectOnDrop: true,
          trackDoneStatus: false,
          Promise
        };
        Bottleneck3.prototype.stopDefaults = {
          enqueueErrorMessage: "This limiter has been stopped and cannot accept new jobs.",
          dropWaitingJobs: true,
          dropErrorMessage: "This limiter has been stopped."
        };
        return Bottleneck3;
      }).call(commonjsGlobal);
      var Bottleneck_1 = Bottleneck2;
      var lib = Bottleneck_1;
      return lib;
    }));
  }
});

// node_modules/universal-user-agent/index.js
function getUserAgent() {
  if (typeof navigator === "object" && "userAgent" in navigator) {
    return navigator.userAgent;
  }
  if (typeof process === "object" && process.version !== void 0) {
    return `Node.js/${process.version.substr(1)} (${process.platform}; ${process.arch})`;
  }
  return "<environment undetectable>";
}

// node_modules/before-after-hook/lib/register.js
function register(state, name, method, options) {
  if (typeof method !== "function") {
    throw new Error("method for before hook must be a function");
  }
  if (!options) {
    options = {};
  }
  if (Array.isArray(name)) {
    return name.reverse().reduce((callback, name2) => {
      return register.bind(null, state, name2, callback, options);
    }, method)();
  }
  return Promise.resolve().then(() => {
    if (!state.registry[name]) {
      return method(options);
    }
    return state.registry[name].reduce((method2, registered) => {
      return registered.hook.bind(null, method2, options);
    }, method)();
  });
}

// node_modules/before-after-hook/lib/add.js
function addHook(state, kind, name, hook2) {
  const orig = hook2;
  if (!state.registry[name]) {
    state.registry[name] = [];
  }
  if (kind === "before") {
    hook2 = (method, options) => {
      return Promise.resolve().then(orig.bind(null, options)).then(method.bind(null, options));
    };
  }
  if (kind === "after") {
    hook2 = (method, options) => {
      let result;
      return Promise.resolve().then(method.bind(null, options)).then((result_) => {
        result = result_;
        return orig(result, options);
      }).then(() => {
        return result;
      });
    };
  }
  if (kind === "error") {
    hook2 = (method, options) => {
      return Promise.resolve().then(method.bind(null, options)).catch((error) => {
        return orig(error, options);
      });
    };
  }
  state.registry[name].push({
    hook: hook2,
    orig
  });
}

// node_modules/before-after-hook/lib/remove.js
function removeHook(state, name, method) {
  if (!state.registry[name]) {
    return;
  }
  const index = state.registry[name].map((registered) => {
    return registered.orig;
  }).indexOf(method);
  if (index === -1) {
    return;
  }
  state.registry[name].splice(index, 1);
}

// node_modules/before-after-hook/index.js
var bind = Function.bind;
var bindable = bind.bind(bind);
function bindApi(hook2, state, name) {
  const removeHookRef = bindable(removeHook, null).apply(
    null,
    name ? [state, name] : [state]
  );
  hook2.api = { remove: removeHookRef };
  hook2.remove = removeHookRef;
  ["before", "error", "after", "wrap"].forEach((kind) => {
    const args = name ? [state, kind, name] : [state, kind];
    hook2[kind] = hook2.api[kind] = bindable(addHook, null).apply(null, args);
  });
}
function Singular() {
  const singularHookName = /* @__PURE__ */ Symbol("Singular");
  const singularHookState = {
    registry: {}
  };
  const singularHook = register.bind(null, singularHookState, singularHookName);
  bindApi(singularHook, singularHookState, singularHookName);
  return singularHook;
}
function Collection() {
  const state = {
    registry: {}
  };
  const hook2 = register.bind(null, state);
  bindApi(hook2, state);
  return hook2;
}
var before_after_hook_default = { Singular, Collection };

// node_modules/@octokit/endpoint/dist-bundle/index.js
var VERSION = "0.0.0-development";
var userAgent = `octokit-endpoint.js/${VERSION} ${getUserAgent()}`;
var DEFAULTS = {
  method: "GET",
  baseUrl: "https://api.github.com",
  headers: {
    accept: "application/vnd.github.v3+json",
    "user-agent": userAgent
  },
  mediaType: {
    format: ""
  }
};
function lowercaseKeys(object) {
  if (!object) {
    return {};
  }
  return Object.keys(object).reduce((newObj, key) => {
    newObj[key.toLowerCase()] = object[key];
    return newObj;
  }, {});
}
function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
function mergeDeep(defaults, options) {
  const result = Object.assign({}, defaults);
  Object.keys(options).forEach((key) => {
    if (isPlainObject(options[key])) {
      if (!(key in defaults)) Object.assign(result, { [key]: options[key] });
      else result[key] = mergeDeep(defaults[key], options[key]);
    } else {
      Object.assign(result, { [key]: options[key] });
    }
  });
  return result;
}
function removeUndefinedProperties(obj) {
  for (const key in obj) {
    if (obj[key] === void 0) {
      delete obj[key];
    }
  }
  return obj;
}
function merge(defaults, route, options) {
  if (typeof route === "string") {
    let [method, url] = route.split(" ");
    options = Object.assign(url ? { method, url } : { url: method }, options);
  } else {
    options = Object.assign({}, route);
  }
  options.headers = lowercaseKeys(options.headers);
  removeUndefinedProperties(options);
  removeUndefinedProperties(options.headers);
  const mergedOptions = mergeDeep(defaults || {}, options);
  if (options.url === "/graphql") {
    if (defaults && defaults.mediaType.previews?.length) {
      mergedOptions.mediaType.previews = defaults.mediaType.previews.filter(
        (preview) => !mergedOptions.mediaType.previews.includes(preview)
      ).concat(mergedOptions.mediaType.previews);
    }
    mergedOptions.mediaType.previews = (mergedOptions.mediaType.previews || []).map((preview) => preview.replace(/-preview/, ""));
  }
  return mergedOptions;
}
function addQueryParameters(url, parameters) {
  const separator = /\?/.test(url) ? "&" : "?";
  const names = Object.keys(parameters);
  if (names.length === 0) {
    return url;
  }
  return url + separator + names.map((name) => {
    if (name === "q") {
      return "q=" + parameters.q.split("+").map(encodeURIComponent).join("+");
    }
    return `${name}=${encodeURIComponent(parameters[name])}`;
  }).join("&");
}
var urlVariableRegex = /\{[^{}}]+\}/g;
function removeNonChars(variableName) {
  return variableName.replace(/(?:^\W+)|(?:(?<!\W)\W+$)/g, "").split(/,/);
}
function extractUrlVariableNames(url) {
  const matches = url.match(urlVariableRegex);
  if (!matches) {
    return [];
  }
  return matches.map(removeNonChars).reduce((a, b) => a.concat(b), []);
}
function omit(object, keysToOmit) {
  const result = { __proto__: null };
  for (const key of Object.keys(object)) {
    if (keysToOmit.indexOf(key) === -1) {
      result[key] = object[key];
    }
  }
  return result;
}
function encodeReserved(str) {
  return str.split(/(%[0-9A-Fa-f]{2})/g).map(function(part) {
    if (!/%[0-9A-Fa-f]/.test(part)) {
      part = encodeURI(part).replace(/%5B/g, "[").replace(/%5D/g, "]");
    }
    return part;
  }).join("");
}
function encodeUnreserved(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}
function encodeValue(operator, value, key) {
  value = operator === "+" || operator === "#" ? encodeReserved(value) : encodeUnreserved(value);
  if (key) {
    return encodeUnreserved(key) + "=" + value;
  } else {
    return value;
  }
}
function isDefined(value) {
  return value !== void 0 && value !== null;
}
function isKeyOperator(operator) {
  return operator === ";" || operator === "&" || operator === "?";
}
function getValues(context, operator, key, modifier) {
  var value = context[key], result = [];
  if (isDefined(value) && value !== "") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      value = value.toString();
      if (modifier && modifier !== "*") {
        value = value.substring(0, parseInt(modifier, 10));
      }
      result.push(
        encodeValue(operator, value, isKeyOperator(operator) ? key : "")
      );
    } else {
      if (modifier === "*") {
        if (Array.isArray(value)) {
          value.filter(isDefined).forEach(function(value2) {
            result.push(
              encodeValue(operator, value2, isKeyOperator(operator) ? key : "")
            );
          });
        } else {
          Object.keys(value).forEach(function(k) {
            if (isDefined(value[k])) {
              result.push(encodeValue(operator, value[k], k));
            }
          });
        }
      } else {
        const tmp = [];
        if (Array.isArray(value)) {
          value.filter(isDefined).forEach(function(value2) {
            tmp.push(encodeValue(operator, value2));
          });
        } else {
          Object.keys(value).forEach(function(k) {
            if (isDefined(value[k])) {
              tmp.push(encodeUnreserved(k));
              tmp.push(encodeValue(operator, value[k].toString()));
            }
          });
        }
        if (isKeyOperator(operator)) {
          result.push(encodeUnreserved(key) + "=" + tmp.join(","));
        } else if (tmp.length !== 0) {
          result.push(tmp.join(","));
        }
      }
    }
  } else {
    if (operator === ";") {
      if (isDefined(value)) {
        result.push(encodeUnreserved(key));
      }
    } else if (value === "" && (operator === "&" || operator === "?")) {
      result.push(encodeUnreserved(key) + "=");
    } else if (value === "") {
      result.push("");
    }
  }
  return result;
}
function parseUrl(template) {
  return {
    expand: expand.bind(null, template)
  };
}
function expand(template, context) {
  var operators = ["+", "#", ".", "/", ";", "?", "&"];
  template = template.replace(
    /\{([^\{\}]+)\}|([^\{\}]+)/g,
    function(_, expression, literal) {
      if (expression) {
        let operator = "";
        const values = [];
        if (operators.indexOf(expression.charAt(0)) !== -1) {
          operator = expression.charAt(0);
          expression = expression.substr(1);
        }
        expression.split(/,/g).forEach(function(variable) {
          var tmp = /([^:\*]*)(?::(\d+)|(\*))?/.exec(variable);
          values.push(getValues(context, operator, tmp[1], tmp[2] || tmp[3]));
        });
        if (operator && operator !== "+") {
          var separator = ",";
          if (operator === "?") {
            separator = "&";
          } else if (operator !== "#") {
            separator = operator;
          }
          return (values.length !== 0 ? operator : "") + values.join(separator);
        } else {
          return values.join(",");
        }
      } else {
        return encodeReserved(literal);
      }
    }
  );
  if (template === "/") {
    return template;
  } else {
    return template.replace(/\/$/, "");
  }
}
function parse(options) {
  let method = options.method.toUpperCase();
  let url = (options.url || "/").replace(/:([a-z]\w+)/g, "{$1}");
  let headers = Object.assign({}, options.headers);
  let body;
  let parameters = omit(options, [
    "method",
    "baseUrl",
    "url",
    "headers",
    "request",
    "mediaType"
  ]);
  const urlVariableNames = extractUrlVariableNames(url);
  url = parseUrl(url).expand(parameters);
  if (!/^http/.test(url)) {
    url = options.baseUrl + url;
  }
  const omittedParameters = Object.keys(options).filter((option) => urlVariableNames.includes(option)).concat("baseUrl");
  const remainingParameters = omit(parameters, omittedParameters);
  const isBinaryRequest = /application\/octet-stream/i.test(headers.accept);
  if (!isBinaryRequest) {
    if (options.mediaType.format) {
      headers.accept = headers.accept.split(/,/).map(
        (format) => format.replace(
          /application\/vnd(\.\w+)(\.v3)?(\.\w+)?(\+json)?$/,
          `application/vnd$1$2.${options.mediaType.format}`
        )
      ).join(",");
    }
    if (url.endsWith("/graphql")) {
      if (options.mediaType.previews?.length) {
        const previewsFromAcceptHeader = headers.accept.match(/(?<![\w-])[\w-]+(?=-preview)/g) || [];
        headers.accept = previewsFromAcceptHeader.concat(options.mediaType.previews).map((preview) => {
          const format = options.mediaType.format ? `.${options.mediaType.format}` : "+json";
          return `application/vnd.github.${preview}-preview${format}`;
        }).join(",");
      }
    }
  }
  if (["GET", "HEAD"].includes(method)) {
    url = addQueryParameters(url, remainingParameters);
  } else {
    if ("data" in remainingParameters) {
      body = remainingParameters.data;
    } else {
      if (Object.keys(remainingParameters).length) {
        body = remainingParameters;
      }
    }
  }
  if (!headers["content-type"] && typeof body !== "undefined") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (["PATCH", "PUT"].includes(method) && typeof body === "undefined") {
    body = "";
  }
  return Object.assign(
    { method, url, headers },
    typeof body !== "undefined" ? { body } : null,
    options.request ? { request: options.request } : null
  );
}
function endpointWithDefaults(defaults, route, options) {
  return parse(merge(defaults, route, options));
}
function withDefaults(oldDefaults, newDefaults) {
  const DEFAULTS2 = merge(oldDefaults, newDefaults);
  const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
  return Object.assign(endpoint2, {
    DEFAULTS: DEFAULTS2,
    defaults: withDefaults.bind(null, DEFAULTS2),
    merge: merge.bind(null, DEFAULTS2),
    parse
  });
}
var endpoint = withDefaults(null, DEFAULTS);

// node_modules/@octokit/request/dist-bundle/index.js
var import_fast_content_type_parse = __toESM(require_fast_content_type_parse(), 1);

// node_modules/@octokit/request-error/dist-src/index.js
var RequestError = class extends Error {
  name;
  /**
   * http status code
   */
  status;
  /**
   * Request options that lead to the error.
   */
  request;
  /**
   * Response object if a response was received
   */
  response;
  constructor(message, statusCode, options) {
    super(message);
    this.name = "HttpError";
    this.status = Number.parseInt(statusCode);
    if (Number.isNaN(this.status)) {
      this.status = 0;
    }
    if ("response" in options) {
      this.response = options.response;
    }
    const requestCopy = Object.assign({}, options.request);
    if (options.request.headers.authorization) {
      requestCopy.headers = Object.assign({}, options.request.headers, {
        authorization: options.request.headers.authorization.replace(
          /(?<! ) .*$/,
          " [REDACTED]"
        )
      });
    }
    requestCopy.url = requestCopy.url.replace(/\bclient_secret=\w+/g, "client_secret=[REDACTED]").replace(/\baccess_token=\w+/g, "access_token=[REDACTED]");
    this.request = requestCopy;
  }
};

// node_modules/@octokit/request/dist-bundle/index.js
var VERSION2 = "9.2.4";
var defaults_default = {
  headers: {
    "user-agent": `octokit-request.js/${VERSION2} ${getUserAgent()}`
  }
};
function isPlainObject2(value) {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
async function fetchWrapper(requestOptions) {
  const fetch = requestOptions.request?.fetch || globalThis.fetch;
  if (!fetch) {
    throw new Error(
      "fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing"
    );
  }
  const log = requestOptions.request?.log || console;
  const parseSuccessResponseBody = requestOptions.request?.parseSuccessResponseBody !== false;
  const body = isPlainObject2(requestOptions.body) || Array.isArray(requestOptions.body) ? JSON.stringify(requestOptions.body) : requestOptions.body;
  const requestHeaders = Object.fromEntries(
    Object.entries(requestOptions.headers).map(([name, value]) => [
      name,
      String(value)
    ])
  );
  let fetchResponse;
  try {
    fetchResponse = await fetch(requestOptions.url, {
      method: requestOptions.method,
      body,
      redirect: requestOptions.request?.redirect,
      headers: requestHeaders,
      signal: requestOptions.request?.signal,
      // duplex must be set if request.body is ReadableStream or Async Iterables.
      // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex.
      ...requestOptions.body && { duplex: "half" }
    });
  } catch (error) {
    let message = "Unknown Error";
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        error.status = 500;
        throw error;
      }
      message = error.message;
      if (error.name === "TypeError" && "cause" in error) {
        if (error.cause instanceof Error) {
          message = error.cause.message;
        } else if (typeof error.cause === "string") {
          message = error.cause;
        }
      }
    }
    const requestError = new RequestError(message, 500, {
      request: requestOptions
    });
    requestError.cause = error;
    throw requestError;
  }
  const status = fetchResponse.status;
  const url = fetchResponse.url;
  const responseHeaders = {};
  for (const [key, value] of fetchResponse.headers) {
    responseHeaders[key] = value;
  }
  const octokitResponse = {
    url,
    status,
    headers: responseHeaders,
    data: ""
  };
  if ("deprecation" in responseHeaders) {
    const matches = responseHeaders.link && responseHeaders.link.match(/<([^<>]+)>; rel="deprecation"/);
    const deprecationLink = matches && matches.pop();
    log.warn(
      `[@octokit/request] "${requestOptions.method} ${requestOptions.url}" is deprecated. It is scheduled to be removed on ${responseHeaders.sunset}${deprecationLink ? `. See ${deprecationLink}` : ""}`
    );
  }
  if (status === 204 || status === 205) {
    return octokitResponse;
  }
  if (requestOptions.method === "HEAD") {
    if (status < 400) {
      return octokitResponse;
    }
    throw new RequestError(fetchResponse.statusText, status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  if (status === 304) {
    octokitResponse.data = await getResponseData(fetchResponse);
    throw new RequestError("Not modified", status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  if (status >= 400) {
    octokitResponse.data = await getResponseData(fetchResponse);
    throw new RequestError(toErrorMessage(octokitResponse.data), status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  octokitResponse.data = parseSuccessResponseBody ? await getResponseData(fetchResponse) : fetchResponse.body;
  return octokitResponse;
}
async function getResponseData(response) {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return response.text().catch(() => "");
  }
  const mimetype = (0, import_fast_content_type_parse.safeParse)(contentType);
  if (isJSONResponse(mimetype)) {
    let text = "";
    try {
      text = await response.text();
      return JSON.parse(text);
    } catch (err) {
      return text;
    }
  } else if (mimetype.type.startsWith("text/") || mimetype.parameters.charset?.toLowerCase() === "utf-8") {
    return response.text().catch(() => "");
  } else {
    return response.arrayBuffer().catch(() => new ArrayBuffer(0));
  }
}
function isJSONResponse(mimetype) {
  return mimetype.type === "application/json" || mimetype.type === "application/scim+json";
}
function toErrorMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return "Unknown error";
  }
  if ("message" in data) {
    const suffix = "documentation_url" in data ? ` - ${data.documentation_url}` : "";
    return Array.isArray(data.errors) ? `${data.message}: ${data.errors.map((v) => JSON.stringify(v)).join(", ")}${suffix}` : `${data.message}${suffix}`;
  }
  return `Unknown error: ${JSON.stringify(data)}`;
}
function withDefaults2(oldEndpoint, newDefaults) {
  const endpoint2 = oldEndpoint.defaults(newDefaults);
  const newApi = function(route, parameters) {
    const endpointOptions = endpoint2.merge(route, parameters);
    if (!endpointOptions.request || !endpointOptions.request.hook) {
      return fetchWrapper(endpoint2.parse(endpointOptions));
    }
    const request2 = (route2, parameters2) => {
      return fetchWrapper(
        endpoint2.parse(endpoint2.merge(route2, parameters2))
      );
    };
    Object.assign(request2, {
      endpoint: endpoint2,
      defaults: withDefaults2.bind(null, endpoint2)
    });
    return endpointOptions.request.hook(request2, endpointOptions);
  };
  return Object.assign(newApi, {
    endpoint: endpoint2,
    defaults: withDefaults2.bind(null, endpoint2)
  });
}
var request = withDefaults2(endpoint, defaults_default);

// node_modules/@octokit/graphql/dist-bundle/index.js
var VERSION3 = "0.0.0-development";
function _buildMessageForResponseErrors(data) {
  return `Request failed due to following response errors:
` + data.errors.map((e) => ` - ${e.message}`).join("\n");
}
var GraphqlResponseError = class extends Error {
  constructor(request2, headers, response) {
    super(_buildMessageForResponseErrors(response));
    this.request = request2;
    this.headers = headers;
    this.response = response;
    this.errors = response.errors;
    this.data = response.data;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  name = "GraphqlResponseError";
  errors;
  data;
};
var NON_VARIABLE_OPTIONS = [
  "method",
  "baseUrl",
  "url",
  "headers",
  "request",
  "query",
  "mediaType",
  "operationName"
];
var FORBIDDEN_VARIABLE_OPTIONS = ["query", "method", "url"];
var GHES_V3_SUFFIX_REGEX = /\/api\/v3\/?$/;
function graphql(request2, query, options) {
  if (options) {
    if (typeof query === "string" && "query" in options) {
      return Promise.reject(
        new Error(`[@octokit/graphql] "query" cannot be used as variable name`)
      );
    }
    for (const key in options) {
      if (!FORBIDDEN_VARIABLE_OPTIONS.includes(key)) continue;
      return Promise.reject(
        new Error(
          `[@octokit/graphql] "${key}" cannot be used as variable name`
        )
      );
    }
  }
  const parsedOptions = typeof query === "string" ? Object.assign({ query }, options) : query;
  const requestOptions = Object.keys(
    parsedOptions
  ).reduce((result, key) => {
    if (NON_VARIABLE_OPTIONS.includes(key)) {
      result[key] = parsedOptions[key];
      return result;
    }
    if (!result.variables) {
      result.variables = {};
    }
    result.variables[key] = parsedOptions[key];
    return result;
  }, {});
  const baseUrl = parsedOptions.baseUrl || request2.endpoint.DEFAULTS.baseUrl;
  if (GHES_V3_SUFFIX_REGEX.test(baseUrl)) {
    requestOptions.url = baseUrl.replace(GHES_V3_SUFFIX_REGEX, "/api/graphql");
  }
  return request2(requestOptions).then((response) => {
    if (response.data.errors) {
      const headers = {};
      for (const key of Object.keys(response.headers)) {
        headers[key] = response.headers[key];
      }
      throw new GraphqlResponseError(
        requestOptions,
        headers,
        response.data
      );
    }
    return response.data.data;
  });
}
function withDefaults3(request2, newDefaults) {
  const newRequest = request2.defaults(newDefaults);
  const newApi = (query, options) => {
    return graphql(newRequest, query, options);
  };
  return Object.assign(newApi, {
    defaults: withDefaults3.bind(null, newRequest),
    endpoint: newRequest.endpoint
  });
}
var graphql2 = withDefaults3(request, {
  headers: {
    "user-agent": `octokit-graphql.js/${VERSION3} ${getUserAgent()}`
  },
  method: "POST",
  url: "/graphql"
});
function withCustomRequest(customRequest) {
  return withDefaults3(customRequest, {
    method: "POST",
    url: "/graphql"
  });
}

// node_modules/@octokit/auth-token/dist-bundle/index.js
var b64url = "(?:[a-zA-Z0-9_-]+)";
var sep = "\\.";
var jwtRE = new RegExp(`^${b64url}${sep}${b64url}${sep}${b64url}$`);
var isJWT = jwtRE.test.bind(jwtRE);
async function auth(token) {
  const isApp = isJWT(token);
  const isInstallation = token.startsWith("v1.") || token.startsWith("ghs_");
  const isUserToServer = token.startsWith("ghu_");
  const tokenType = isApp ? "app" : isInstallation ? "installation" : isUserToServer ? "user-to-server" : "oauth";
  return {
    type: "token",
    token,
    tokenType
  };
}
function withAuthorizationPrefix(token) {
  if (token.split(/\./).length === 3) {
    return `bearer ${token}`;
  }
  return `token ${token}`;
}
async function hook(token, request2, route, parameters) {
  const endpoint2 = request2.endpoint.merge(
    route,
    parameters
  );
  endpoint2.headers.authorization = withAuthorizationPrefix(token);
  return request2(endpoint2);
}
var createTokenAuth = function createTokenAuth2(token) {
  if (!token) {
    throw new Error("[@octokit/auth-token] No token passed to createTokenAuth");
  }
  if (typeof token !== "string") {
    throw new Error(
      "[@octokit/auth-token] Token passed to createTokenAuth is not a string"
    );
  }
  token = token.replace(/^(token|bearer) +/i, "");
  return Object.assign(auth.bind(null, token), {
    hook: hook.bind(null, token)
  });
};

// node_modules/@octokit/core/dist-src/version.js
var VERSION4 = "6.1.6";

// node_modules/@octokit/core/dist-src/index.js
var noop = () => {
};
var consoleWarn = console.warn.bind(console);
var consoleError = console.error.bind(console);
function createLogger(logger = {}) {
  if (typeof logger.debug !== "function") {
    logger.debug = noop;
  }
  if (typeof logger.info !== "function") {
    logger.info = noop;
  }
  if (typeof logger.warn !== "function") {
    logger.warn = consoleWarn;
  }
  if (typeof logger.error !== "function") {
    logger.error = consoleError;
  }
  return logger;
}
var userAgentTrail = `octokit-core.js/${VERSION4} ${getUserAgent()}`;
var Octokit = class {
  static VERSION = VERSION4;
  static defaults(defaults) {
    const OctokitWithDefaults = class extends this {
      constructor(...args) {
        const options = args[0] || {};
        if (typeof defaults === "function") {
          super(defaults(options));
          return;
        }
        super(
          Object.assign(
            {},
            defaults,
            options,
            options.userAgent && defaults.userAgent ? {
              userAgent: `${options.userAgent} ${defaults.userAgent}`
            } : null
          )
        );
      }
    };
    return OctokitWithDefaults;
  }
  static plugins = [];
  /**
   * Attach a plugin (or many) to your Octokit instance.
   *
   * @example
   * const API = Octokit.plugin(plugin1, plugin2, plugin3, ...)
   */
  static plugin(...newPlugins) {
    const currentPlugins = this.plugins;
    const NewOctokit = class extends this {
      static plugins = currentPlugins.concat(
        newPlugins.filter((plugin) => !currentPlugins.includes(plugin))
      );
    };
    return NewOctokit;
  }
  constructor(options = {}) {
    const hook2 = new before_after_hook_default.Collection();
    const requestDefaults = {
      baseUrl: request.endpoint.DEFAULTS.baseUrl,
      headers: {},
      request: Object.assign({}, options.request, {
        // @ts-ignore internal usage only, no need to type
        hook: hook2.bind(null, "request")
      }),
      mediaType: {
        previews: [],
        format: ""
      }
    };
    requestDefaults.headers["user-agent"] = options.userAgent ? `${options.userAgent} ${userAgentTrail}` : userAgentTrail;
    if (options.baseUrl) {
      requestDefaults.baseUrl = options.baseUrl;
    }
    if (options.previews) {
      requestDefaults.mediaType.previews = options.previews;
    }
    if (options.timeZone) {
      requestDefaults.headers["time-zone"] = options.timeZone;
    }
    this.request = request.defaults(requestDefaults);
    this.graphql = withCustomRequest(this.request).defaults(requestDefaults);
    this.log = createLogger(options.log);
    this.hook = hook2;
    if (!options.authStrategy) {
      if (!options.auth) {
        this.auth = async () => ({
          type: "unauthenticated"
        });
      } else {
        const auth2 = createTokenAuth(options.auth);
        hook2.wrap("request", auth2.hook);
        this.auth = auth2;
      }
    } else {
      const { authStrategy, ...otherOptions } = options;
      const auth2 = authStrategy(
        Object.assign(
          {
            request: this.request,
            log: this.log,
            // we pass the current octokit instance as well as its constructor options
            // to allow for authentication strategies that return a new octokit instance
            // that shares the same internal state as the current one. The original
            // requirement for this was the "event-octokit" authentication strategy
            // of https://github.com/probot/octokit-auth-probot.
            octokit: this,
            octokitOptions: otherOptions
          },
          options.auth
        )
      );
      hook2.wrap("request", auth2.hook);
      this.auth = auth2;
    }
    const classConstructor = this.constructor;
    for (let i = 0; i < classConstructor.plugins.length; ++i) {
      Object.assign(this, classConstructor.plugins[i](this, options));
    }
  }
  // assigned during constructor
  request;
  graphql;
  log;
  hook;
  // TODO: type `octokit.auth` based on passed options.authStrategy
  auth;
};

// node_modules/@octokit/plugin-retry/dist-bundle/index.js
var import_light = __toESM(require_light(), 1);
var VERSION5 = "0.0.0-development";
async function errorRequest(state, octokit, error, options) {
  if (!error.request || !error.request.request) {
    throw error;
  }
  if (error.status >= 400 && !state.doNotRetry.includes(error.status)) {
    const retries = options.request.retries != null ? options.request.retries : state.retries;
    const retryAfter = Math.pow((options.request.retryCount || 0) + 1, 2);
    throw octokit.retry.retryRequest(error, retries, retryAfter);
  }
  throw error;
}
async function wrapRequest(state, octokit, request2, options) {
  const limiter = new import_light.default();
  limiter.on("failed", function(error, info) {
    const maxRetries = ~~error.request.request.retries;
    const after = ~~error.request.request.retryAfter;
    options.request.retryCount = info.retryCount + 1;
    if (maxRetries > info.retryCount) {
      return after * state.retryAfterBaseValue;
    }
  });
  return limiter.schedule(
    requestWithGraphqlErrorHandling.bind(null, state, octokit, request2),
    options
  );
}
async function requestWithGraphqlErrorHandling(state, octokit, request2, options) {
  const response = await request2(request2, options);
  if (response.data && response.data.errors && response.data.errors.length > 0 && /Something went wrong while executing your query/.test(
    response.data.errors[0].message
  )) {
    const error = new RequestError(response.data.errors[0].message, 500, {
      request: options,
      response
    });
    return errorRequest(state, octokit, error, options);
  }
  return response;
}
function retry(octokit, octokitOptions) {
  const state = Object.assign(
    {
      enabled: true,
      retryAfterBaseValue: 1e3,
      doNotRetry: [400, 401, 403, 404, 410, 422, 451],
      retries: 3
    },
    octokitOptions.retry
  );
  if (state.enabled) {
    octokit.hook.error("request", errorRequest.bind(null, state, octokit));
    octokit.hook.wrap("request", wrapRequest.bind(null, state, octokit));
  }
  return {
    retry: {
      retryRequest: (error, retries, retryAfter) => {
        error.request.request = Object.assign({}, error.request.request, {
          retries,
          retryAfter
        });
        return error;
      }
    }
  };
}
retry.VERSION = VERSION5;

// node_modules/@octokit/plugin-throttling/dist-bundle/index.js
var import_light2 = __toESM(require_light(), 1);
var VERSION6 = "0.0.0-development";
var noop2 = () => Promise.resolve();
function wrapRequest2(state, request2, options) {
  return state.retryLimiter.schedule(doRequest, state, request2, options);
}
async function doRequest(state, request2, options) {
  const { pathname } = new URL(options.url, "http://github.test");
  const isAuth = isAuthRequest(options.method, pathname);
  const isWrite = !isAuth && options.method !== "GET" && options.method !== "HEAD";
  const isSearch = options.method === "GET" && pathname.startsWith("/search/");
  const isGraphQL = pathname.startsWith("/graphql");
  const retryCount = ~~request2.retryCount;
  const jobOptions = retryCount > 0 ? { priority: 0, weight: 0 } : {};
  if (state.clustering) {
    jobOptions.expiration = 1e3 * 60;
  }
  if (isWrite || isGraphQL) {
    await state.write.key(state.id).schedule(jobOptions, noop2);
  }
  if (isWrite && state.triggersNotification(pathname)) {
    await state.notifications.key(state.id).schedule(jobOptions, noop2);
  }
  if (isSearch) {
    await state.search.key(state.id).schedule(jobOptions, noop2);
  }
  const req = (isAuth ? state.auth : state.global).key(state.id).schedule(jobOptions, request2, options);
  if (isGraphQL) {
    const res = await req;
    if (res.data.errors != null && res.data.errors.some((error) => error.type === "RATE_LIMITED")) {
      const error = Object.assign(new Error("GraphQL Rate Limit Exceeded"), {
        response: res,
        data: res.data
      });
      throw error;
    }
  }
  return req;
}
function isAuthRequest(method, pathname) {
  return method === "PATCH" && // https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-a-scoped-access-token
  /^\/applications\/[^/]+\/token\/scoped$/.test(pathname) || method === "POST" && // https://docs.github.com/en/rest/apps/oauth-applications?apiVersion=2022-11-28#reset-a-token
  (/^\/applications\/[^/]+\/token$/.test(pathname) || // https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app
  /^\/app\/installations\/[^/]+\/access_tokens$/.test(pathname) || // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
  pathname === "/login/oauth/access_token");
}
var triggers_notification_paths_default = [
  "/orgs/{org}/invitations",
  "/orgs/{org}/invitations/{invitation_id}",
  "/orgs/{org}/teams/{team_slug}/discussions",
  "/orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments",
  "/repos/{owner}/{repo}/collaborators/{username}",
  "/repos/{owner}/{repo}/commits/{commit_sha}/comments",
  "/repos/{owner}/{repo}/issues",
  "/repos/{owner}/{repo}/issues/{issue_number}/comments",
  "/repos/{owner}/{repo}/issues/{issue_number}/sub_issue",
  "/repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority",
  "/repos/{owner}/{repo}/pulls",
  "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
  "/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
  "/repos/{owner}/{repo}/pulls/{pull_number}/merge",
  "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  "/repos/{owner}/{repo}/releases",
  "/teams/{team_id}/discussions",
  "/teams/{team_id}/discussions/{discussion_number}/comments"
];
function routeMatcher(paths) {
  const regexes = paths.map(
    (path) => path.split("/").map((c) => c.startsWith("{") ? "(?:.+?)" : c).join("/")
  );
  const regex2 = `^(?:${regexes.map((r) => `(?:${r})`).join("|")})[^/]*$`;
  return new RegExp(regex2, "i");
}
var regex = routeMatcher(triggers_notification_paths_default);
var triggersNotification = regex.test.bind(regex);
var groups = {};
var createGroups = function(Bottleneck2, common) {
  groups.global = new Bottleneck2.Group({
    id: "octokit-global",
    maxConcurrent: 10,
    ...common
  });
  groups.auth = new Bottleneck2.Group({
    id: "octokit-auth",
    maxConcurrent: 1,
    ...common
  });
  groups.search = new Bottleneck2.Group({
    id: "octokit-search",
    maxConcurrent: 1,
    minTime: 2e3,
    ...common
  });
  groups.write = new Bottleneck2.Group({
    id: "octokit-write",
    maxConcurrent: 1,
    minTime: 1e3,
    ...common
  });
  groups.notifications = new Bottleneck2.Group({
    id: "octokit-notifications",
    maxConcurrent: 1,
    minTime: 3e3,
    ...common
  });
};
function throttling(octokit, octokitOptions) {
  const {
    enabled = true,
    Bottleneck: Bottleneck2 = import_light2.default,
    id = "no-id",
    timeout = 1e3 * 60 * 2,
    // Redis TTL: 2 minutes
    connection
  } = octokitOptions.throttle || {};
  if (!enabled) {
    return {};
  }
  const common = { timeout };
  if (typeof connection !== "undefined") {
    common.connection = connection;
  }
  if (groups.global == null) {
    createGroups(Bottleneck2, common);
  }
  const state = Object.assign(
    {
      clustering: connection != null,
      triggersNotification,
      fallbackSecondaryRateRetryAfter: 60,
      retryAfterBaseValue: 1e3,
      retryLimiter: new Bottleneck2(),
      id,
      ...groups
    },
    octokitOptions.throttle
  );
  if (typeof state.onSecondaryRateLimit !== "function" || typeof state.onRateLimit !== "function") {
    throw new Error(`octokit/plugin-throttling error:
        You must pass the onSecondaryRateLimit and onRateLimit error handlers.
        See https://octokit.github.io/rest.js/#throttling

        const octokit = new Octokit({
          throttle: {
            onSecondaryRateLimit: (retryAfter, options) => {/* ... */},
            onRateLimit: (retryAfter, options) => {/* ... */}
          }
        })
    `);
  }
  const events = {};
  const emitter = new Bottleneck2.Events(events);
  events.on("secondary-limit", state.onSecondaryRateLimit);
  events.on("rate-limit", state.onRateLimit);
  events.on(
    "error",
    (e) => octokit.log.warn("Error in throttling-plugin limit handler", e)
  );
  state.retryLimiter.on("failed", async function(error, info) {
    const [state2, request2, options] = info.args;
    const { pathname } = new URL(options.url, "http://github.test");
    const shouldRetryGraphQL = pathname.startsWith("/graphql") && error.status !== 401;
    if (!(shouldRetryGraphQL || error.status === 403 || error.status === 429)) {
      return;
    }
    const retryCount = ~~request2.retryCount;
    request2.retryCount = retryCount;
    options.request.retryCount = retryCount;
    const { wantRetry, retryAfter = 0 } = await (async function() {
      if (/\bsecondary rate\b/i.test(error.message)) {
        const retryAfter2 = Number(error.response.headers["retry-after"]) || state2.fallbackSecondaryRateRetryAfter;
        const wantRetry2 = await emitter.trigger(
          "secondary-limit",
          retryAfter2,
          options,
          octokit,
          retryCount
        );
        return { wantRetry: wantRetry2, retryAfter: retryAfter2 };
      }
      if (error.response.headers != null && error.response.headers["x-ratelimit-remaining"] === "0" || (error.response.data?.errors ?? []).some(
        (error2) => error2.type === "RATE_LIMITED"
      )) {
        const rateLimitReset = new Date(
          ~~error.response.headers["x-ratelimit-reset"] * 1e3
        ).getTime();
        const retryAfter2 = Math.max(
          // Add one second so we retry _after_ the reset time
          // https://docs.github.com/en/rest/overview/resources-in-the-rest-api?apiVersion=2022-11-28#exceeding-the-rate-limit
          Math.ceil((rateLimitReset - Date.now()) / 1e3) + 1,
          0
        );
        const wantRetry2 = await emitter.trigger(
          "rate-limit",
          retryAfter2,
          options,
          octokit,
          retryCount
        );
        return { wantRetry: wantRetry2, retryAfter: retryAfter2 };
      }
      return {};
    })();
    if (wantRetry) {
      request2.retryCount++;
      return retryAfter * state2.retryAfterBaseValue;
    }
  });
  octokit.hook.wrap("request", wrapRequest2.bind(null, state));
  return {};
}
throttling.VERSION = VERSION6;
throttling.triggersNotification = triggersNotification;

// src/types.ts
var COPILOT_LOGIN = "copilot-swe-agent";
var COPILOT_ASSIGNEE_LOGIN = "Copilot";
var INITIAL_PLAN_COMMIT = "Initial plan";

// src/approval.ts
function referencedSecretNames(workflowYaml) {
  const found = /* @__PURE__ */ new Set();
  if (/^\s*secrets\s*:\s*inherit\s*$/m.test(workflowYaml)) {
    found.add("<inherit: every repository secret>");
  }
  const patterns = [
    /secrets\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /secrets\[\s*['"]([^'"]+)['"]\s*\]/g
  ];
  for (const pattern of patterns) {
    for (const match of workflowYaml.matchAll(pattern)) {
      const name = match[1];
      if (name && name.toUpperCase() !== "GITHUB_TOKEN") found.add(name);
    }
  }
  return [...found].sort();
}
function extractOnSection(workflowYaml) {
  const lines = workflowYaml.split(/\r?\n/);
  const index = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
  if (index === -1) return null;
  const header = lines[index] ?? "";
  const inline = header.slice(header.indexOf(":") + 1).trim();
  if (inline && !inline.startsWith("#")) return inline;
  const block = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}
function triggersOnPullRequest(workflowYaml) {
  const section = extractOnSection(workflowYaml);
  if (section === null) return true;
  return /\bpull_request(_target)?\b/.test(section);
}
function usesSelfHostedRunner(workflowYaml) {
  return /\bself-hosted\b/.test(workflowYaml);
}

// src/github.ts
var FactoryOctokit = Octokit.plugin(retry, throttling);
var OBJECTIVE_QUERY = `
query Objective($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    id
    defaultBranchRef { name }
    workItemLabel: label(name: "factory:work-item") { id }
    suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 10) {
      nodes {
        login
        ... on Bot { id }
      }
    }
    issue(number: $number) {
      id
      number
      title
      body
      state
      subIssues(first: 100) {
        nodes {
          id
          number
          title
          state
          assignees(first: 10) { nodes { login } }
          labels(first: 20) { nodes { name } }
          blockedBy(first: 50) { nodes { number state } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            nodes {
              id
              number
              state
              isDraft
              title
              body
              mergeable
              createdAt
              mergedAt
              closedAt
              additions
              deletions
              changedFiles
              files(first: 100) {
                nodes { path }
              }
              commits(first: 100) {
                nodes { commit { messageHeadline } }
              }
              statusCheckRollup: commits(last: 1) {
                nodes {
                  commit {
                    oid
                    committedDate
                    statusCheckRollup { state }
                    checkSuites(first: 20) {
                      nodes {
                        status
                        conclusion
                        checkRuns { totalCount }
                      }
                    }
                  }
                }
              }
            }
          }
          timelineItems(last: 10, itemTypes: [ASSIGNED_EVENT]) {
            nodes {
              ... on AssignedEvent {
                createdAt
                assignee {
                  ... on Bot { login }
                  ... on User { login }
                }
              }
            }
          }
        }
      }
    }
  }
}`;
function normalizeChecks(pr) {
  const commit = pr.statusCheckRollup.nodes[0]?.commit;
  const raw = commit?.statusCheckRollup?.state;
  if (raw) {
    switch (raw) {
      case "PENDING":
      case "EXPECTED":
        return "PENDING";
      case "SUCCESS":
        return "SUCCESS";
      default:
        return "FAILURE";
    }
  }
  return runlessSuiteVerdict(commit?.checkSuites.nodes ?? []);
}
function runlessSuiteVerdict(suites) {
  const runless = suites.filter((s) => s.checkRuns.totalCount === 0);
  if (runless.length === 0) return null;
  if (runless.some((s) => s.status !== "COMPLETED")) return "PENDING";
  const benign = /* @__PURE__ */ new Set(["SUCCESS", "NEUTRAL", "SKIPPED", null]);
  return runless.some((s) => !benign.has(s.conclusion)) ? "FAILURE" : null;
}
function toPullRequest(pr, agentWorkEvents = []) {
  const commit = pr.statusCheckRollup.nodes[0]?.commit;
  const checks = normalizeChecks(pr);
  return {
    id: pr.id,
    number: pr.number,
    state: pr.state,
    isDraft: pr.isDraft,
    title: pr.title,
    body: pr.body ?? "",
    changedLines: pr.additions + pr.deletions,
    changedFiles: pr.changedFiles,
    changedFilePaths: pr.files.nodes.map((n) => n.path),
    commitSubjects: pr.commits.nodes.map((n) => n.commit.messageHeadline),
    checks,
    checksNeverStarted: checks === "FAILURE" && !commit?.statusCheckRollup?.state,
    mergeable: pr.mergeable,
    createdAt: new Date(pr.createdAt),
    mergedAt: pr.mergedAt ? new Date(pr.mergedAt) : null,
    closedAt: pr.closedAt ? new Date(pr.closedAt) : null,
    headSha: commit?.oid ?? "",
    // Falling back to the PR's own creation time keeps the field a real Date
    // even for the (unobserved) case of a pull request with no commits: a
    // brand-new PR is then trivially "recently active", which errs toward
    // waiting rather than toward closing something live.
    headCommittedAt: commit?.committedDate ? new Date(commit.committedDate) : new Date(pr.createdAt),
    agentWorkEvents
  };
}
var AGENT_EVENT_KINDS = {
  copilot_work_started: "started",
  copilot_work_finished: "finished",
  copilot_work_finished_failure: "failed"
};
function toAgentWorkEvents(nodes) {
  return nodes.flatMap((n) => {
    const kind = n.event ? AGENT_EVENT_KINDS[n.event] : void 0;
    const at = new Date(n.created_at ?? "");
    if (!kind || !Number.isFinite(at.getTime())) return [];
    return [{
      kind,
      at,
      message: n.failure_message ?? n.message ?? null
    }];
  }).sort((a, b) => a.at.getTime() - b.at.getTime());
}
function copilotAssignments(wi) {
  return wi.timelineItems.nodes.filter((e) => e.assignee?.login === COPILOT_LOGIN).map((e) => new Date(e.createdAt)).sort((a, b) => a.getTime() - b.getTime());
}
function toWorkItem(wi, eventsByPullRequest) {
  const blockedBy = wi.blockedBy.nodes.map((d) => ({
    number: d.number,
    closed: d.state === "CLOSED"
  }));
  return {
    id: wi.id,
    number: wi.number,
    title: wi.title,
    closed: wi.state === "CLOSED",
    assignees: wi.assignees.nodes.map((a) => a.login),
    labels: wi.labels?.nodes.map((l) => l.name) ?? [],
    blockedBy,
    linkedPullRequests: wi.closedByPullRequestsReferences.nodes.map(
      (pr) => toPullRequest(pr, eventsByPullRequest.get(pr.number) ?? [])
    ),
    copilotAssignments: copilotAssignments(wi)
  };
}
function createOctokit(opts) {
  const notify = opts.onThrottle ?? (() => {
  });
  return new FactoryOctokit({
    auth: opts.token,
    throttle: {
      onRateLimit: (after, o) => {
        notify(`rate limit on ${o.method} ${o.url}; retrying in ${after}s`);
        return true;
      },
      onSecondaryRateLimit: (after, o) => {
        notify(`secondary limit on ${o.method} ${o.url}; retrying in ${after}s`);
        return true;
      }
    }
  });
}
function interpretContentsResponse(path, body, maxBytes) {
  if (Array.isArray(body)) {
    return {
      path,
      exists: true,
      truncated: false,
      unreadable: `not a file (directory with ${body.length} entries) \u2014 use read_repository_layout with pathPrefix instead`
    };
  }
  const data = body ?? {};
  if (data.type !== "file" || typeof data.content !== "string") {
    const where = data.target ?? data.submodule_git_url;
    return {
      path,
      exists: true,
      truncated: false,
      unreadable: `not a file (${data.type ?? "unknown"})${where ? ` \u2014 points at ${where}` : ""}`
    };
  }
  if (data.content === "" && (data.size ?? 0) > 0) {
    return {
      path,
      exists: true,
      truncated: true,
      unreadable: `no content returned for a ${data.size}-byte file \u2014 the contents API omits it above 1 MB`
    };
  }
  const text = Buffer.from(data.content, "base64").toString("utf8");
  const clipped = text.length > maxBytes;
  return {
    path,
    exists: true,
    content: clipped ? text.slice(0, maxBytes) : text,
    truncated: clipped
  };
}
function isRequested(path, paths) {
  return paths.some(
    (entry) => entry.endsWith("/") ? path.startsWith(entry) : path === entry
  );
}
function budgetPatches(files, maxPatchBytes, paths) {
  let budget = maxPatchBytes;
  let truncated = false;
  const filtering = paths !== void 0 && paths.length > 0;
  const out = files.map((f) => {
    const base = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions
    };
    if (filtering && !isRequested(f.filename, paths)) {
      return {
        ...base,
        patch: null,
        patchOmitted: "not requested; add this path to `paths` to read it"
      };
    }
    if (f.patch === null || f.patch === void 0) {
      return {
        ...base,
        patch: null,
        patchOmitted: "binary, or too large for GitHub to return a patch"
      };
    }
    if (budget <= 0) {
      truncated = true;
      return {
        ...base,
        patch: null,
        patchOmitted: "read budget exhausted; re-read this file with a larger maxPatchBytes"
      };
    }
    const slice = f.patch.length > budget ? f.patch.slice(0, budget) : f.patch;
    budget -= slice.length;
    if (slice.length < f.patch.length) {
      truncated = true;
      return { ...base, patch: slice, patchOmitted: "truncated mid-file" };
    }
    return { ...base, patch: slice };
  });
  return { files: out, truncated };
}
var GitHubReader = class {
  #octokit;
  #owner;
  #repo;
  /** Latched once true by `#ciExpectedOnPullRequests`. */
  #ciExpected = false;
  /** Cached for the process lifetime by `readWorkflowSafetyProfile`. */
  #safetyProfile;
  #cachedDefaultBranch;
  constructor(opts) {
    this.#owner = opts.owner;
    this.#repo = opts.repo;
    this.#octokit = createOctokit(opts);
  }
  /**
   * Read the actual patch text of a pull request, per file (§7.3).
   *
   * This exists because the confidence bar requires Director to judge that
   * "the diff satisfies the Work Item's acceptance criteria and nothing more"
   * — a *semantic* check that `evaluate_mechanical` deliberately does not make
   * (§5.1 is mechanical only). Without patch text the snapshot exposes
   * `changedFilePaths` but no content, so that half of the bar is unmet by
   * construction: a criterion like "must import and actually call `truncate`,
   * not reimplement it" is uncheckable from file-path evidence alone (§10).
   *
   * Uses the REST files endpoint rather than the `.diff` media type because it
   * returns per-file `additions`/`deletions`/`status` alongside the patch,
   * which is what the bar actually reasons about. GitHub omits `patch` for
   * binary files and for individual files above its own size limit; those come
   * back with `patch: null`, reported honestly rather than silently dropped.
   *
   * `paths` restricts which files spend the byte budget (§10). The
   * budget is otherwise first-come-first-served in GitHub's ordering, so one
   * large file early in the alphabet starves every file after it —
   * `package-lock.json` consumed a 4000-byte allowance whole and left the three
   * files under review with `patch: null`. Pass a Work Item's declared `scope`
   * (the matching rules are the same: a trailing `/` selects a directory) to
   * spend the whole budget on the files the review is about.
   *
   * Filtered-out files are still listed, with `status`, `additions` and
   * `deletions` intact and `patchOmitted` explaining why — the complete file
   * list is what the blast-radius review and the scope checks reason about, and
   * shortening it would misreport the size of the change. For the same reason
   * `truncated` stays `false` when content is withheld only by `paths`: it means
   * "content you asked for was cut", and a filtered file was not asked for.
   */
  async readPullRequestDiff(pullNumber, maxPatchBytes = 6e4, paths) {
    const raw = [];
    let incomplete = false;
    const maxPages = 30;
    for (let page = 1; page <= maxPages; page++) {
      const response = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        {
          owner: this.#owner,
          repo: this.#repo,
          pull_number: pullNumber,
          per_page: 100,
          page
        }
      );
      raw.push(...response.data);
      if (response.data.length < 100) break;
      if (page === maxPages) incomplete = true;
    }
    const { files: entries, truncated } = budgetPatches(raw, maxPatchBytes, paths);
    return { pullNumber, files: entries, truncated: truncated || incomplete };
  }
  /**
   * List every file on the default branch, so compilation can ground a Work
   * Item's `scope` in the repository as it actually is.
   *
   * Without this, `scope` is compiled purely by inferring conventional
   * structure from the Objective's prose. A wrong guess does not fail at compile
   * time — it fails several steps later as an `untouched` verdict, after an
   * agent run has been spent, and reads like the agent ignored its brief rather
   * than like the brief named a path that was never there.
   *
   * One recursive tree request rather than walking directories: `truncated`
   * here is GitHub's own flag, raised on repositories too large to return in
   * one response, and is reported rather than worked around. Blobs only —
   * directory entries are implied by the paths and would only spend budget.
   */
  async readRepositoryLayout(pathPrefix, maxEntries = 2e3) {
    const branch = await this.#defaultBranch();
    const tree = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      {
        owner: this.#owner,
        repo: this.#repo,
        tree_sha: branch,
        recursive: "1"
      }
    );
    const all = tree.data.tree.filter((e) => e.type === "blob" && typeof e.path === "string").map((e) => e.path);
    const matched = pathPrefix ? all.filter((p) => p.startsWith(pathPrefix)) : all;
    matched.sort();
    const files = matched.slice(0, maxEntries);
    return {
      defaultBranch: branch,
      files,
      totalFiles: matched.length,
      // Either GitHub could not return the whole tree, or we cut it ourselves.
      // Collapsing both into one flag would let a caller believe it had seen
      // every file when it had not, which is the mistake this whole method
      // exists to prevent.
      truncated: Boolean(tree.data.truncated) || files.length < matched.length,
      treeTruncatedByGitHub: Boolean(tree.data.truncated)
    };
  }
  /**
   * Read one file's text from the default branch, for the questions a layout
   * cannot answer — whether a helper already exists, what a test file's
   * conventions are, which runner `package.json` declares.
   *
   * Returns `exists: false` rather than throwing on 404, because "this path is
   * not in the repository" is a normal, informative answer during compilation
   * and not an error worth aborting a cycle over.
   *
   * But the contents API answers 404 to two very different questions — "no such
   * path" and "no such repository, or none you can see" — and compilation acts
   * on the difference. A bad `owner`/`repo` or a token without access would
   * otherwise return a confident `exists: false` for every path asked about, and
   * the graph would be compiled to create files that already exist. So a 404 is
   * only reported as a missing path once the repository itself is confirmed
   * readable; `#defaultBranch()` caches, so this costs one request per reader.
   */
  async readRepositoryFile(path, maxBytes = 4e4) {
    let response;
    try {
      response = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner: this.#owner, repo: this.#repo, path }
      );
    } catch (error) {
      if (error.status === 404) {
        try {
          await this.#defaultBranch();
        } catch {
          throw new Error(
            `cannot read ${this.#owner}/${this.#repo} \u2014 the repository does not exist or this token cannot see it. Not reporting "${path}" as missing, because every path would look missing.`
          );
        }
        return { path, exists: false, truncated: false };
      }
      throw error;
    }
    return interpretContentsResponse(path, response.data, maxBytes);
  }
  async #defaultBranch() {
    if (this.#cachedDefaultBranch) return this.#cachedDefaultBranch;
    const repo = await this.#octokit.request("GET /repos/{owner}/{repo}", {
      owner: this.#owner,
      repo: this.#repo
    });
    this.#cachedDefaultBranch = repo.data.default_branch;
    return this.#cachedDefaultBranch;
  }
  /** Read one Objective and everything derivable about its Work Items. */
  async readObjective(number) {
    const data = await this.#octokit.graphql(OBJECTIVE_QUERY, {
      owner: this.#owner,
      repo: this.#repo,
      number
    });
    const repository = data.repository;
    const issue = repository?.issue;
    if (!repository || !issue) {
      throw new Error(
        `Objective #${number} not found in ${this.#owner}/${this.#repo}`
      );
    }
    if (!repository.defaultBranchRef) {
      throw new Error(
        `${this.#owner}/${this.#repo} has no default branch (empty repository?)`
      );
    }
    const bot = repository.suggestedActors.nodes.find(
      (a) => a.login === COPILOT_LOGIN
    );
    const agentWorkEvents = await this.#readAgentWorkEvents(issue.subIssues.nodes);
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      closed: issue.state === "CLOSED",
      workItems: issue.subIssues.nodes.map(
        (wi) => toWorkItem(wi, agentWorkEvents)
      ),
      readAt: /* @__PURE__ */ new Date(),
      repositoryId: repository.id,
      defaultBranch: repository.defaultBranchRef.name,
      workItemLabelId: repository.workItemLabel?.id ?? null,
      copilotBotId: bot?.id ?? null,
      ciExpectedOnPullRequests: await this.#ciExpectedOnPullRequests()
    };
  }
  /**
   * Read Copilot session events for current attempts through REST.
   *
   * GitHub's public GraphQL schema no longer contains the Copilot timeline
   * types, so mentioning them makes the entire Objective query invalid even
   * when there are no Work Items. The REST issue timeline still reports the
   * measured event names. Only open linked pull requests can be a current
   * attempt, which keeps the companion reads proportional to active work and
   * avoids re-reading every closed historical attempt on every cycle.
   */
  async #readAgentWorkEvents(workItems) {
    const openPullRequests = /* @__PURE__ */ new Set();
    for (const workItem of workItems) {
      for (const pullRequest of workItem.closedByPullRequestsReferences.nodes) {
        if (pullRequest.state === "OPEN") openPullRequests.add(pullRequest.number);
      }
    }
    const result = /* @__PURE__ */ new Map();
    for (const pullNumber of openPullRequests) {
      const timeline = [];
      for (let page = 1; ; page++) {
        const response = await this.#octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
          {
            owner: this.#owner,
            repo: this.#repo,
            issue_number: pullNumber,
            per_page: 100,
            page,
            headers: { accept: "application/vnd.github+json" }
          }
        );
        timeline.push(...response.data);
        if (response.data.length < 100) break;
      }
      result.set(pullNumber, toAgentWorkEvents(timeline));
    }
    return result;
  }
  /**
   * Whether this repository has ever run a workflow on a `pull_request` event.
   *
   * One cheap REST call (`per_page=1`, only `total_count` is read), and the
   * answer is latched once true — a repository that runs CI on pull requests
   * does not stop being one mid-Objective, so the call is made at most once per
   * process after the first positive.
   *
   * Deliberately evidence-based rather than configuration-based: listing
   * workflows would say a repository *has* Actions, but not whether any of them
   * apply to pull requests (a release-only or schedule-only workflow would then
   * block every merge forever). Asking whether a `pull_request` run has ever
   * existed answers the question that actually matters. It also degrades
   * gracefully — the run created for the PR under review counts, so even the
   * first pull request a repository ever receives is covered as soon as its own
   * run is created, which is the window before checks attach to the commit.
   *
   * Returns `"unknown"` rather than `false` when the probe itself fails. A 5xx,
   * a rate-limit or a dropped connection says nothing about whether CI exists,
   * and reporting it as `false` told the evaluator "this repository has no CI"
   * — merging a pull request with zero checks on the strength of a network
   * error. `"unknown"` is not latched: the next cycle asks again, so a
   * transient failure costs one cycle of caution rather than poisoning the
   * process.
   */
  async #ciExpectedOnPullRequests() {
    if (this.#ciExpected) return true;
    try {
      const runs = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/actions/runs",
        {
          owner: this.#owner,
          repo: this.#repo,
          event: "pull_request",
          per_page: 1
        }
      );
      if (runs.data.total_count > 0) this.#ciExpected = true;
    } catch (error) {
      const status = error?.status;
      if (status === 404 || status === 403) return false;
      return "unknown";
    }
    return this.#ciExpected;
  }
  /**
   * Read the facts a blast-radius review needs about what an approved workflow
   * run would be *allowed* to do (§9).
   *
   * Two questions, two sources: the repo's default token scope, and whether any
   * pull-request workflow pulls in a real secret. Both are properties of the
   * base branch, not of the pull request, which is the point — they describe the
   * job the diff would be run *by*, and the review separately proves the diff
   * cannot change that job.
   *
   * Cached for the process lifetime: these are settings, they do not move
   * within a cycle, and re-reading them per Work Item would burn rate limit for
   * no new information.
   *
   * Fails closed. Any error leaves `defaultWorkflowPermissions: "unknown"`,
   * which `assessBlastRadius` treats as a blocker — a review that cannot see the
   * token scope has not established anything.
   */
  async readWorkflowSafetyProfile() {
    if (this.#safetyProfile) return this.#safetyProfile;
    let defaultWorkflowPermissions = "unknown";
    try {
      const perms = await this.#octokit.request(
        "GET /repos/{owner}/{repo}/actions/permissions/workflow",
        { owner: this.#owner, repo: this.#repo }
      );
      const value = perms.data.default_workflow_permissions;
      if (value === "read" || value === "write") defaultWorkflowPermissions = value;
    } catch {
    }
    const referencedSecrets = /* @__PURE__ */ new Set();
    try {
      const workflows = [];
      for (let page = 1; page <= 10; page++) {
        const response = await this.#octokit.request(
          "GET /repos/{owner}/{repo}/actions/workflows",
          { owner: this.#owner, repo: this.#repo, per_page: 100, page }
        );
        workflows.push(...response.data.workflows);
        if (response.data.workflows.length < 100) break;
      }
      for (const workflow of workflows) {
        if (workflow.state !== "active") continue;
        if (!workflow.path.startsWith(".github/")) continue;
        try {
          const file = await this.#octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            { owner: this.#owner, repo: this.#repo, path: workflow.path }
          );
          const data = file.data;
          if (!data.content) {
            referencedSecrets.add(`<unreadable: ${workflow.path}>`);
            continue;
          }
          const yaml = Buffer.from(data.content, "base64").toString("utf8");
          if (usesSelfHostedRunner(yaml)) {
            referencedSecrets.add(`<self-hosted runner: ${workflow.path}>`);
          }
          if (!triggersOnPullRequest(yaml)) continue;
          for (const name of referencedSecretNames(yaml)) referencedSecrets.add(name);
        } catch {
          referencedSecrets.add(`<unreadable: ${workflow.path}>`);
        }
      }
    } catch {
      referencedSecrets.add("<unreadable: workflows could not be listed>");
    }
    this.#safetyProfile = {
      defaultWorkflowPermissions,
      referencedSecrets: [...referencedSecrets].sort()
    };
    return this.#safetyProfile;
  }
  /**
   * List workflow runs for a head commit that are parked awaiting approval.
   *
   * Filtered by `head_sha` because that is the only handle the REST API offers
   * for "runs belonging to this pull request" — runs carry no PR number. An
   * empty SHA is refused rather than sent: GitHub treats an empty `head_sha` as
   * an absent filter, which would return every held run in the repository and
   * turn "unknown head commit" into "match everything" inside a write path.
   *
   * The `action_required` status is the whole signal: it is what GitHub sets on
   * a run it created but refuses to start until a maintainer approves it. A run
   * in any other state needs nothing from us.
   *
   * Only pull-request events are returned. `readWorkflowSafetyProfile` scopes
   * its secret scan to pull-request-triggered workflows, so approving a `push`
   * or `workflow_dispatch` run would act on a wider set than the review covered
   * — the two must describe the same set or the assurances are false. Held runs
   * from other events are reported separately so Director can escalate them.
   */
  async listRunsAwaitingApproval(headSha) {
    if (!headSha) {
      throw new Error(
        "cannot list held workflow runs without a head commit SHA; an empty SHA would match every held run in the repository"
      );
    }
    const runs = await this.#octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: this.#owner,
        repo: this.#repo,
        head_sha: headSha,
        status: "action_required",
        per_page: 100
      }
    );
    const all = runs.data.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name ?? String(run.id),
      event: run.event
    }));
    return {
      approvable: all.filter(
        (r) => r.event === "pull_request" || r.event === "pull_request_target"
      ),
      otherEvents: all.filter(
        (r) => r.event !== "pull_request" && r.event !== "pull_request_target"
      )
    };
  }
  /**
   * Resolve a login to its GraphQL node ID, needed once at startup to
   * configure `Dispatcher`'s escalation target (§7.2). A plain, stable
   * `user(login:)` lookup — not part of the per-cycle snapshot.
   */
  async resolveUserId(login) {
    let data;
    try {
      data = await this.#octokit.graphql(
        `query ResolveUser($login: String!) { user(login: $login) { id } }`,
        { login }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Could not resolve to a User/i.test(message)) {
        throw new Error(`${notFoundMessage(login)} (GitHub said: ${message.trim()})`);
      }
      throw error;
    }
    if (!data.user) throw new Error(notFoundMessage(login));
    return data.user.id;
  }
};
function notFoundMessage(login) {
  return `GitHub user '${login}' not found. Check the exact account login: it is not necessarily the prefix of a branch name, an email local-part, or a display name. If this login was going to be used as an escalation target, it would have failed at the moment a human was needed \u2014 resolve it now instead.`;
}

// src/auth.ts
import { execFileSync } from "node:child_process";
function resolveGitHubToken(env = process.env, readGhToken = () => execFileSync("gh", ["auth", "token"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 5e3
})) {
  const forwarded = env["GITHUB_TOKEN"]?.trim() || env["GH_TOKEN"]?.trim();
  if (forwarded) return forwarded;
  try {
    const token = readGhToken().trim();
    if (token) return token;
  } catch {
  }
  throw new Error(
    "GitHub authentication unavailable: set GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`"
  );
}

// src/state.ts
function isNoOp(pr) {
  const hasDiff = pr.changedLines > 0 || pr.changedFiles > 0;
  if (hasDiff) return false;
  const realCommits = pr.commitSubjects.filter(
    (s) => s.trim() !== INITIAL_PLAN_COMMIT
  );
  return realCommits.length === 0;
}
function checksSettled(pr) {
  return pr.checks !== "PENDING";
}
function isAssignedToCopilot(wi) {
  return wi.assignees.includes(COPILOT_ASSIGNEE_LOGIN);
}
var DISPATCH_CONFIRM_WINDOW_MS = 9e4;
var DECLINE_TITLE_PATTERN = /^\s*no-?op\s*:/i;
var WIP_TITLE_PATTERN = /^\s*\[wip\]/i;
function isWorkInProgress(pr) {
  return WIP_TITLE_PATTERN.test(pr.title);
}
var EMPTY_PULL_REQUEST_GRACE_MS = 6e5;
function withinEmptyPullRequestGrace(pr, now) {
  if (DECLINE_TITLE_PATTERN.test(pr.title)) return false;
  return now.getTime() - pr.createdAt.getTime() < EMPTY_PULL_REQUEST_GRACE_MS;
}
var WIP_INACTIVITY_GRACE_MS = 12e5;
function isAbandonedAttempt(pr, now) {
  if (!isWorkInProgress(pr)) return false;
  return now.getTime() - pr.headCommittedAt.getTime() >= WIP_INACTIVITY_GRACE_MS;
}
function agentFailure(pr) {
  let last = null;
  for (const event of pr.agentWorkEvents) {
    if (!last || event.at.getTime() >= last.at.getTime()) last = event;
  }
  if (!last || last.kind !== "failed") return null;
  if (pr.headCommittedAt.getTime() > last.at.getTime()) return null;
  return last;
}
function latestCopilotAssignment(wi) {
  if (wi.copilotAssignments.length === 0) return null;
  return wi.copilotAssignments[wi.copilotAssignments.length - 1];
}
function withinConfirmWindow(wi, now) {
  const assignedAt = latestCopilotAssignment(wi);
  if (!assignedAt) return false;
  return now.getTime() - assignedAt.getTime() < DISPATCH_CONFIRM_WINDOW_MS;
}
function humanAssignees(wi) {
  return wi.assignees.filter((a) => a !== COPILOT_ASSIGNEE_LOGIN);
}
function attemptCount(wi) {
  return wi.linkedPullRequests.length;
}
function currentOpenPullRequest(wi) {
  const open = wi.linkedPullRequests.filter((p) => p.state === "OPEN");
  if (open.length === 0) return null;
  return open.reduce(
    (newest, p) => p.createdAt.getTime() !== newest.createdAt.getTime() ? p.createdAt > newest.createdAt ? p : newest : p.number > newest.number ? p : newest
  );
}
function deriveState(wi, now) {
  if (wi.closed) return "done";
  const merged = wi.linkedPullRequests.filter((p) => p.state === "MERGED");
  if (merged.length > 0) return "done";
  if (!isAssignedToCopilot(wi) && humanAssignees(wi).length > 0) {
    return "escalated";
  }
  const current = currentOpenPullRequest(wi);
  if (current) {
    const failure = agentFailure(current);
    if (isNoOp(current)) {
      const stillPlausiblyWorking = !failure && (withinConfirmWindow(wi, now) || withinEmptyPullRequestGrace(current, now));
      return stillPlausiblyWorking ? "in_flight" : "failed";
    }
    if (failure && isWorkInProgress(current)) return "failed";
    if (isAbandonedAttempt(current, now)) return "failed";
    if (isWorkInProgress(current)) return "in_flight";
    if (checksSettled(current)) return "for_review";
    return "in_flight";
  }
  if (isAssignedToCopilot(wi)) return "dispatched";
  if (wi.blockedBy.some((d) => !d.closed)) return "blocked";
  return "unstarted";
}
function derive(snapshot) {
  return {
    id: snapshot.id,
    number: snapshot.number,
    title: snapshot.title,
    body: snapshot.body,
    closed: snapshot.closed,
    readAt: snapshot.readAt,
    repositoryId: snapshot.repositoryId,
    defaultBranch: snapshot.defaultBranch,
    copilotBotId: snapshot.copilotBotId,
    ciExpectedOnPullRequests: snapshot.ciExpectedOnPullRequests,
    items: snapshot.workItems.map((wi) => {
      const state = deriveState(wi, snapshot.readAt);
      return {
        ...wi,
        state,
        attempts: attemptCount(wi),
        doneWithoutMergedPullRequest: state === "done" && !wi.linkedPullRequests.some((p) => p.state === "MERGED")
      };
    })
  };
}
function inState(o, ...states) {
  return o.items.filter((i) => states.includes(i.state));
}
function ready(o) {
  return o.items.filter(
    (i) => i.state === "unstarted" && i.blockedBy.every((d) => d.closed)
  );
}
function allDone(o) {
  return o.items.length > 0 && o.items.every((i) => i.state === "done");
}
function isStalled(o) {
  if (allDone(o)) return false;
  const moving = inState(o, "dispatched", "in_flight", "for_review", "failed");
  return moving.length === 0 && ready(o).length === 0;
}
function counts(o) {
  const c = {
    unstarted: 0,
    dispatched: 0,
    in_flight: 0,
    failed: 0,
    for_review: 0,
    blocked: 0,
    escalated: 0,
    done: 0
  };
  for (const i of o.items) c[i.state] += 1;
  return c;
}

// src/cli.ts
function fail(message) {
  process.stderr.write(`${message}
`);
  process.exit(1);
}
async function main(argv) {
  const [slug, rawNumber] = argv;
  if (!slug || !rawNumber) {
    fail("usage: factory <owner>/<repo> <objective-number>");
  }
  const [owner, repo] = slug.split("/");
  const number = Number(rawNumber);
  if (!owner || !repo || !Number.isInteger(number)) {
    fail(`bad arguments: ${slug} ${rawNumber}`);
  }
  let token;
  try {
    token = resolveGitHubToken();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const reader = new GitHubReader({
    token,
    owner,
    repo,
    onThrottle: (m) => process.stderr.write(`[throttle] ${m}
`)
  });
  const objective = derive(await reader.readObjective(number));
  process.stdout.write(`
#${objective.number} ${objective.title}
`);
  process.stdout.write(`read at ${objective.readAt.toISOString()}

`);
  if (objective.items.length === 0) {
    process.stdout.write("  (no work items)\n");
  }
  for (const item of objective.items) {
    const blockers = item.blockedBy.filter((d) => !d.closed).map((d) => `#${d.number}`);
    const notes = [
      item.attempts > 0 ? `${item.attempts} attempt(s)` : null,
      blockers.length > 0 ? `blocked by ${blockers.join(", ")}` : null
    ].filter(Boolean);
    process.stdout.write(
      `  ${item.state.padEnd(11)} #${item.number} ${item.title}` + (notes.length > 0 ? `  [${notes.join("; ")}]` : "") + "\n"
    );
  }
  const c = counts(objective);
  const summary = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ");
  process.stdout.write(`
${summary || "empty"}
`);
  process.stdout.write(
    `ready=${ready(objective).length} stalled=${isStalled(objective)} allDone=${allDone(objective)}
`
  );
}
await main(process.argv.slice(2));
export {
  main
};
