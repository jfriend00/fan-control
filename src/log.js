"use strict";

var util = require('util');

/*
// version using the spread operator (which for some unknown reason does not work in node.js 5.x)
function log(level, ...args) {
    var output = [level];
    try {
        output.push(new Date().toString());
        args.forEach(function(item) {
            var t = typeof item;
            if (t === "object") {
                output.push(JSON.stringify(item));
            } else if (t !== "undefined") {
                output.push(item);
            }
        });
    } catch(e) {
        output.push("exception thrown in log() - partial logging output");
    }
    console.log(output.join("; "));
}
*/


var tags = {};
var dayMs = 1000 * 60 * 60 * 24;

// use an interval timer to clear out tags older than a day 
// note - if the server is configured to restart every day at 4am, then this code will never run
// because the server never actually has more than 24hrs of uptime
setInterval(function() {
    var now = Date.now();
    Object.keys(tags).forEach(function(tag) {
        if (now - tags[tag] > dayMs) {
            delete tags[tag];
        }
    });
}, dayMs + (1000*60*10)).unref();

var suffixes = {
    ms: 1,
    sec: 1000,
    min: 1000 * 60,
    hr:  1000 * 60 * 60,
    day: 1000 * 60 * 60 * 24,
    year: 1000 * 60 * 60 * 24 * 365
};

function convertToMs(num, suffix) {
    var result = num;
    if (suffix) {
        let multiplier = suffixes[suffix];
        if (multiplier) {
            result = num * multiplier;
        } else {
            throw new Error('Unrecognized suffix "' + suffix + '" on time value');
        }
    }
    return Math.round(result);
}

// Accepts the following forms (whitespace is optional before suffix)
// Decimal values are allowed as input, but only an integer will be output
// 1234
// 1111 ms
// 2222 sec
// 3333 min
// 4444 hr
// 5555 day
// 6666 year
function parseTimeToMs(val) {
    if (typeof val === "number") return Math.round(val);
    if (typeof val === "string") {
        let matches = val.match(/^\s*([\d.]+)\s*([a-z]+)?\s*$/);
        if (matches) {
            return convertToMs(+matches[1], matches[2]);
        }
    }
    // if not already returned from the function, then it must have been a bad format
    throw new Error("Illegal time value: " + val);
}

// can be used as:
//  log(3, "Some msg");
//  log({tag: "waiting", level: 3, delta: xxx}, "Some msg");
//  log({level: 3, delta: xxx}, "Some msg");         if tag is not present, then first msg is used as the tag
// delta value can be any of the forms that parseTimeToMs() takes
function log(options) {
    var output = [];
    try {
        var args = Array.prototype.slice.call(arguments, 1);
        if (typeof options === "object") {
            output.push(options.level);
            let tag = options.tag || args[0];
            let now = Date.now();
            let priorTime = tags[tag];
            let delta = parseTimeToMs(options.delta || 0);
            if (!priorTime || now - priorTime >= delta) {
                // update the tag time and let the normal processing occur
                tags[tag] = now;
            } else {
                // not enough time has passed to show this message
                return;
            }
        } else {
            // must be just plain level value
            output.push(options);
        }
        output.push(new Date().toString());
        args.forEach(function(item) {
            var t = typeof item;
            if (t === "object") {
                output.push(util.inspect(item, {showHidden: true, depth: null}));
            } else if (t !== "undefined") {
                output.push(item);
            }
        });
    } catch(e) {
        output.push("exception " + util.inspect(e, {showHidden: true, depth: null}) + "\n - partial logging output");
    }
    console.log(output.join("; "));
}

module.exports = log;