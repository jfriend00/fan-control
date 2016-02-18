const Promise = require('bluebird');
const ntpClient = Promise.promisifyAll(require('ntp-client'));
const log = require('./log');

function Decay(startT, maxT, decayAmount, decayTimes) {
    // startT is initial delay (e.g. 5 seconds)
    // maxT is the max delay this ever returns (e.g. 5 minutes)
    // decayAmount is how much to decay when a threshold is crossed (e.g. increase by 0.5)
    // decayTimes is how many invocations should trigger a decayAmount (e.g. every 5 times)

    // example: var d = new Decay(5000, 5*60*1000, .5, 5);
    // each 5 seconds, to a max of 5 minutes, getting 50% longer every 5 invocations
    
    // make sure decayTimes is at least 1 and not negative
    decayTimes = Math.max(decayTimes, 1);
    var num = 0;
    var currentDelay = startT;
    var start = Date.now();
    
    this.val = function() {
        var elapsed = Date.now() - start;
        // if evenly divisible by decayTimes, then bump the increment
        if (num !== 0 && num % decayTimes === 0) {
            currentDelay = Math.min(Math.round((1 + decayAmount) * currentDelay), maxT);
        }
        ++num;
        return currentDelay;
    };
}

function checkSystemTime(precision) {
    precision = precision || 5000;
    return ntpClient.getNetworkTimeAsync("pool.ntp.org", 123).then(function(ntpTime) {
        return Math.abs(ntpTime.getTime() - Date.now()) <= precision;
    }, function(err) {
        log(1, "ntp time error: ", err);
        throw err;
    });
}

function waitForAccurateSystemTime(precision, howLong) {
    var start = Date.now();
    var decay = new Decay(5000, 5*60*1000, .5, 5);
    return new Promise(function(resolve, reject) {
    
        function check() {
            checkSystemTime(precision).then(function(accurate) {
                if (accurate) {
                    resolve(true);
                } else {
                    again();
                }
            }, again);
        }
        
        function again() {
            if (!howLong || Date.now() - start <= howLong) {
                setTimeout(check, decay.val());
            } else {
                reject("timeout waiting for accurate system time");
            }
        }
        
        check();
    });
}

module.exports = {
    checkSystemTime: checkSystemTime,
    waitForAccurateSystemTime: waitForAccurateSystemTime,
    Decay: Decay
};
