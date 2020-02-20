"use strict"
;(function(m) {
if (typeof module !== "undefined") module["exports"] = m()
else window.o = m()
})(function init(name) {
	// # Setup
	// const
	var spec = {}
	var subjects = []
	var hasProcess = typeof process === "object", hasOwn = ({}).hasOwnProperty
	var only = []
	var ospecFileName = getStackName(ensureStackTrace(new Error), /[\/\\](.*?):\d+:\d+/)

	// stack-managed globals
	var ctx = spec
	var currentTestError = null
	var globalTimeout = noTimeoutRightNow
	var Assert = AssertFactory()
	var depth = 1

	if (name != null) spec[name] = ctx = {}

	// Shared state, set only once, but initialization is delayed
	var results, start, timeoutStackName

	// # Core helpers
	var stack = 0
	var nextTickish = hasProcess
		? process.nextTick
		: function fakeFastNextTick(next) {
			if (stack++ < 5000) next()
			else setTimeout(next, stack = 0)
		}

	function Task(fn, err, hookName) {
		// This test needs to be here rather than in `o("name", test(){})`
		// in order to also cover nested hooks.
		// `err` is null for internal tasks that can be defined at any time.
		if (isRunning() && err != null) throw new Error("Test definitions and hooks shouldn't be nested. To group tests, use 'o.spec()'.")
		this.fn = fn
		this.err = err
		this.hookName = hookName
		this.depth = depth
	}

	function isRunning() {return results != null}

	function ensureStackTrace(error) {
		// mandatory to get a stack in IE 10 and 11 (and maybe other envs?)
		if (error.stack === undefined) try { throw error } catch(e) {return e}
		else return error
	}

	function getStackName(e, exp) {
		return e.stack && exp.test(e.stack) ? e.stack.match(exp)[1] : null
	}

	function hook(name) {
		return function(predicate) {
			if (ctx[name]) throw new Error(name.slice(1) + " should be defined outside of a loop or inside a nested test group.")
			ctx[name] = new Task(predicate, ensureStackTrace(new Error), name.slice(1))
		}
	}

	function noTimeoutRightNow() {
		throw new Error("o.timeout must be called snchronously from within a test definition or a hook.")
	}

	function unique(subject) {
		if (hasOwn.call(ctx, subject)) {
			console.warn("A test or a spec named '" + subject + "' was already defined.")
			while (hasOwn.call(ctx, subject)) subject += "*"
		}
		return subject
	}

	// # API
	function o(subject, predicate) {
		if (predicate === undefined) {
			if (!isRunning()) throw new Error("Assertions should not occur outside test definitions.")
			return new Assert(subject)
		} else {
			subject = String(subject)
			if (subject.charCodeAt(0) === 1) throw new Error("test names starting with '\\x01' are reserved for internal use.")
			ctx[unique(subject)] = new Task(predicate, ensureStackTrace(new Error))
		}
	}

	o.before = hook("\x01before")
	o.after = hook("\x01after")
	o.beforeEach = hook("\x01beforeEach")
	o.afterEach = hook("\x01afterEach")

	o.specTimeout = function (t) {
		if (isRunning()) throw new Error("o.specTimeout() can only be called before o.run().")
		if (hasOwn.call(ctx, "\x01specTimeout")) throw new Error("A default timeout has already been defined in this context.")
		if (typeof t !== "number") throw new Error("o.specTimeout() expects a number as argument.")
		ctx["\x01specTimeout"] = t
	}

	o.new = init

	o.spec = function(subject, predicate) {
		// stack managed globals
		var previousAssert = Assert
		var parent = ctx
		ctx = ctx[unique(subject)] = {}
		depth++
		predicate()
		depth--
		ctx = parent
		Assert = previousAssert
	}

	o.only = function(subject, predicate, silent) {
		if (!silent) console.log(
			highlight("/!\\ WARNING /!\\ o.only() mode") + "\n" + o.cleanStackTrace(ensureStackTrace(new Error)) + "\n",
			cStyle("red"), ""
		)
		only.push(predicate)
		o(subject, predicate)
	}

	o.spy = function(fn) {
		var spy = function() {
			spy.this = this
			spy.args = [].slice.call(arguments)
			spy.calls.push({this: this, args: spy.args})
			spy.callCount++

			if (fn) return fn.apply(this, arguments)
		}
		if (fn)
			Object.defineProperties(spy, {
				length: {value: fn.length},
				name: {value: fn.name}
			})
		spy.args = []
		spy.calls = []
		spy.callCount = 0
		return spy
	}

	o.cleanStackTrace = function(error) {
		// For IE 10+ in quirks mode, and IE 9- in any mode, errors don't have a stack
		if (error.stack == null) return ""
		var i = 0, header = error.message ? error.name + ": " + error.message : error.name, stack
		// some environments add the name and message to the stack trace
		if (error.stack.indexOf(header) === 0) {
			stack = error.stack.slice(header.length).split(/\r?\n/)
			stack.shift() // drop the initial empty string
		} else {
			stack = error.stack.split(/\r?\n/)
		}
		if (ospecFileName == null) return stack.join("\n")
		// skip ospec-related entries on the stack
		while (stack[i] != null && stack[i].indexOf(ospecFileName) !== -1) i++
		// now we're in user code (or past the stack end)
		return stack[i]
	}

	o.timeout = function(n) {
		globalTimeout(n)
	}

	o.addExtension = function(name, handler) {
		if (isRunning()) throw new Error("please add extensions outside of tests")
		if (ctx === spec) throw new Error("you can't extend the global scope")
		if (name in Assert.prototype) throw new Error("attempt at redefining o()." + name + "()")
		if (ctx["\x01CustomAssert"] == null) {
			var proto = Object.create(Assert.prototype)
			Assert = AssertFactory()
			Assert.prototype = proto
			ctx["\x01CustomAssert"] = Assert
		}
		Assert.prototype[name] = createAssertion(handler)
	}

	// # Test runner
	o.run = function(reporter) {
		results = []
		start = new Date

		var finalizer = new Task(function() {
			setTimeout(function () {
				timeoutStackName = getStackName({stack: o.cleanStackTrace(ensureStackTrace(new Error))}, /([\w \.]+?:\d+:\d+)/)
				if (typeof reporter === "function") reporter(results)
				else {
					var errCount = o.report(results)
					if (hasProcess && errCount !== 0) process.exit(1) // eslint-disable-line no-process-exit
				}
			})
		}, null)

		runSpec(spec, [], [], finalizer, 200 /*default timeout delay*/)

		function runSpec(spec, beforeEach, afterEach, finalize, defaultDelay) {
			// stack managed globals
			var previousAssert = Assert
			if (spec["\x01CustomAssert"] != null) Assert = spec["\x01CustomAssert"]

			if (hasOwn.call(spec, "\x01specTimeout")) defaultDelay = spec["\x01specTimeout"]

			var restoreStack = new Task(function() {
				Assert = previousAssert
			})

			beforeEach = [].concat(beforeEach, spec["\x01beforeEach"] || [])
			afterEach = [].concat(spec["\x01afterEach"] || [], afterEach)

			series(
				[].concat(
					spec["\x01before"] || [],
					Object.keys(spec).reduce(function(tasks, key) {
						if (
							// Skip the hooks ...
							key.charCodeAt(0) !== 1
							&& (
								// ... and, if in `only` mode, the tasks that are not flagged to run.
								only.length === 0
								|| only.indexOf(spec[key].fn) !== -1
								// Always run specs though, in case there are `only` tests nested in there.
								|| !(spec[key] instanceof Task)
							)
						) {
							tasks.push(new Task(function(done) {
								o.timeout(Infinity)
								subjects.push(key)
								var popSubjects = new Task(function pop() {subjects.pop(), done()}, null)
								if (spec[key] instanceof Task) {
									// this is a test
									series(
										[].concat(beforeEach, spec[key], afterEach, popSubjects),
										defaultDelay
									)
								} else {
									// a spec...
									runSpec(spec[key], beforeEach, afterEach, popSubjects, defaultDelay)
								}
							}, null))
						}
						return tasks
					}, []),
					spec["\x01after"] || [],
					restoreStack,
					finalize
				),
				defaultDelay
			)
		}

		function series(tasks, defaultDelay) {
			var cursor = 0
			next()

			function next() {
				if (cursor === tasks.length) return

				var task = tasks[cursor++]
				var fn = task.fn
				var isHook = task.hookName != null
				currentTestError = task.err
				var timeout = 0, delay = defaultDelay, s = new Date
				var current = cursor
				var isDone = false
				var arg
				// console.log({task, depth})
				globalTimeout = setDelay
				if (isHook) {
					subjects.push("[[ o."+ task.hookName + Array.apply(null, {length: task.depth}).join("*") + " ]]")
				}

				// public API, may only be called once from use code (or after returned Promise resolution)
				function done(err) {
					if (!isDone) isDone = true
					else throw new Error("'" + arg + "()' should only be called once.")
					if (timeout === undefined) console.warn("# elapsed: " + Math.round(new Date - s) + "ms, expected under " + delay + "ms\n" + o.cleanStackTrace(task.err))
					finalizeAsync(err)
				}
				// for internal use only
				function finalizeAsync(err) {
					if (err == null) {
						if (task.err != null) succeed(new Assert().result)
					} else {
						if (err instanceof Error) fail(new Assert().result, err.message, err)
						else fail(new Assert().result, String(err), null)
					}
					if (timeout !== undefined) timeout = clearTimeout(timeout)
					if (current === cursor) {
						// TODO: figure out a way to test that this works properly in async contexts
						// this probably isn't... The way current is defined and cursor is incremented
						// will have to be revisited
						if (isHook) subjects.pop()
						next()
					}
				}
				function startTimer() {
					timeout = setTimeout(function() {
						timeout = undefined
						finalizeAsync("async test timed out after " + delay + "ms")
					}, Math.min(delay, 2147483647))
				}
				function setDelay (t) {
					if (typeof t !== "number") throw new Error("timeout() and o.timeout() expect a number as argument.")
					delay = t
				}
				if (fn.length > 0) {
					var body = fn.toString()
					// Don't change the RegExp by hand, it is generated by
					// `scripts/build-done-parser.js`.
					// If needed, update the script and paste its output here.
					arg = (body.match(/^(?:(?:function(?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*(?:\b[^\s(\/]+(?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*)?)?\((?:\s|\/\*[^]*?\*\/|\/\/[^\n]*\n)*)?([^\s{[),=\/]+)/) || []).pop()
					if (body.indexOf(arg) === body.lastIndexOf(arg)) {
						var e = new Error
						e.stack = "'" + arg + "()' should be called at least once\n" + o.cleanStackTrace(task.err)
						throw e
					}
					try {
						fn(done, setDelay)
					}
					catch (e) {
						if (task.err != null) finalizeAsync(e)
						// The errors of internal tasks (which don't have an Err) are ospec bugs and must be rethrown.
						else throw e
					}
					if (timeout === 0) {
						startTimer()
					}
				} else {
					try{
						var p = fn()
						if (p && p.then) {
							startTimer()
							p.then(function() { done() }, done)
						} else {
							if (isHook) subjects.pop()
							nextTickish(next)
						}
					} catch (e) {
						if (task.err != null) finalizeAsync(e)
						// The errors of internal tasks (which don't have an Err) are ospec bugs and must be rethrown.
						else throw e
					}
				}
				globalTimeout = noTimeoutRightNow
			}
		}
	}
	// #Assertions
	function AssertFactory() {
		return function Assert(value) {
			this.value = value
			this.result = {pass: null, context: subjects.join(" > "), message: "Incomplete assertion in the test definition starting at...", error: currentTestError, testError: currentTestError}
			results.push(this.result)
		}
	}

	function createAssertion(f) {
		return function(expected) {
			var self = this
			try {
				succeed(self.result, f(self.value, expected))
			} catch (e) {
				if (e instanceof Error) fail(self.result, e.message, e)
				else fail(self.result, e)
			}
			return function(message) {
				if (!self.result.pass) {
					self.result.message = message + "\n\n" + self.result.message
				}
			}
		}
	}

	function define(name, verb, compare) {
		Assert.prototype[name] = createAssertion(function(actual, expected) {
			var message = serialize(actual) + "\n  " + verb + "\n" + serialize(expected)
			if (compare(actual, expected)) return message
			else throw message
		})
	}

	define("equals", "should equal", function(a, b) {return a === b})
	define("notEquals", "should not equal", function(a, b) {return a !== b})
	define("deepEquals", "should deep equal", deepEqual)
	define("notDeepEquals", "should not deep equal", function(a, b) {return !deepEqual(a, b)})
	define("throws", "should throw a", throws)
	define("notThrows", "should not throw a", function(a, b) {return !throws(a, b)})

	function isArguments(a) {
		if ("callee" in a) {
			for (var i in a) if (i === "callee") return false
			return true
		}
	}

	function deepEqual(a, b) {
		if (a === b) return true
		if (a === null ^ b === null || a === undefined ^ b === undefined) return false // eslint-disable-line no-bitwise
		if (typeof a === "object" && typeof b === "object") {
			var aIsArgs = isArguments(a), bIsArgs = isArguments(b)
			if (a.constructor === Object && b.constructor === Object && !aIsArgs && !bIsArgs) {
				for (var i in a) {
					if ((!(i in b)) || !deepEqual(a[i], b[i])) return false
				}
				for (var i in b) {
					if (!(i in a)) return false
				}
				return true
			}
			if (a.length === b.length && (a instanceof Array && b instanceof Array || aIsArgs && bIsArgs)) {
				var aKeys = Object.getOwnPropertyNames(a), bKeys = Object.getOwnPropertyNames(b)
				if (aKeys.length !== bKeys.length) return false
				for (var i = 0; i < aKeys.length; i++) {
					if (!hasOwn.call(b, aKeys[i]) || !deepEqual(a[aKeys[i]], b[aKeys[i]])) return false
				}
				return true
			}
			if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
			if (typeof Buffer === "function" && a instanceof Buffer && b instanceof Buffer) {
				for (var i = 0; i < a.length; i++) {
					if (a[i] !== b[i]) return false
				}
				return true
			}
			if (a.valueOf() === b.valueOf()) return true
		}
		return false
	}

	function throws(a, b){
		try{
			a()
		}catch(e){
			if(typeof b === "string"){
				return (e.message === b)
			}else{
				return (e instanceof b)
			}
		}
		return false
	}

	function succeed(result, message) {
		result.pass = true
		result.message = message
	}

	function fail(result, message, error) {
		result.pass = false
		result.message = message
		result.error = error != null ? error : ensureStackTrace(new Error)
	}

	function serialize(value) {
		if (hasProcess) return require("util").inspect(value) // eslint-disable-line global-require
		if (value === null || (typeof value === "object" && !(value instanceof Array)) || typeof value === "number") return String(value)
		else if (typeof value === "function") return value.name || "<anonymous function>"
		try {return JSON.stringify(value)} catch (e) {return String(value)}
	}

	// Reporter helpers
	var colorCodes = {
		red: "31m",
		red2: "31;1m",
		green: "32;1m"
	}

	function highlight(message, color) {
		var code = colorCodes[color] || colorCodes.red;
		return hasProcess ? (process.stdout.isTTY ? "\x1b[" + code + message + "\x1b[0m" : message) : "%c" + message + "%c "
	}

	function cStyle(color, bold) {
		return hasProcess||!color ? "" : "color:"+color+(bold ? ";font-weight:bold" : "")
	}

	o.report = function (results) {
		var errCount = 0
		for (var i = 0, r; r = results[i]; i++) {
			if (r.pass == null) {
				r.testError.stack = r.message + "\n" + o.cleanStackTrace(r.testError)
				r.testError.message = r.message
				throw r.testError
			}
			if (!r.pass) {
				var stackTrace = o.cleanStackTrace(r.error)
				var couldHaveABetterStackTrace = !stackTrace || timeoutStackName != null && stackTrace.indexOf(timeoutStackName) !== -1
				if (couldHaveABetterStackTrace) stackTrace = r.testError != null ? o.cleanStackTrace(r.testError) : r.error.stack || ""
				console.error(
					(hasProcess ? "\n" : "") +
					highlight(r.context + ":", "red2") + "\n" +
					highlight(r.message, "red") +
					(stackTrace ? "\n" + stackTrace + "\n" : ""),

					cStyle("black", true), "", // reset to default
					cStyle("red"), cStyle("black")
				)
				errCount++
			}
		}
		var pl = results.length === 1 ? "" : "s"
		var resultSummary = (errCount === 0) ?
			highlight((pl ? "All " : "The ") + results.length + " assertion" + pl + " passed", "green"):
			highlight(errCount + " out of " + results.length + " assertion" + pl + " failed", "red2")
		var runningTime = " in " + Math.round(Date.now() - start) + "ms"

		console.log(
			(hasProcess ? "––––––\n" : "") +
			(name ? name + ": " : "") + resultSummary + runningTime,
			cStyle((errCount === 0 ? "green" : "red"), true), ""
		)
		return errCount
	}
	return o
})
