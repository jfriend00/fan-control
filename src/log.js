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

function log(level) {
    var args = Array.prototype.slice.call(arguments, 1);
    var output = [level];
    try {
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