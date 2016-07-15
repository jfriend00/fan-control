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
}, dayMs + (1000*60*10));

// can be used as:
//  log(3, "Some msg");
//  log({tag: "waiting", level: 3, delta: xxx}, "Some msg");
//  log({level: 3, delta: xxx}, "Some msg");         if tag is not present, then first msg is used as the tag
function log(options) {
    var output = [];
    try {
        var args = Array.prototype.slice.call(arguments, 1);
        if (typeof options === "object") {
            output.push(options.level);
            let tag = options.tag || args[0];
            let now = Date.now();
            let priorTime = tags[tag];
            if (!priorTime || now - priorTime > options.delta) {
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
        output.push("exception thrown in log() - partial logging output");
    }
    console.log(output.join("; "));
}

module.exports = log;