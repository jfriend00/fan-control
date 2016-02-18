"use strict";
var os = require('os');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var express = require('express');
var hbs = require('hbs');
var gpio = require('./pi-gpio');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var validate = require('./validate');
var timeAverager = require('./averager').timeAverager;
var readLines = require("./line-reader").readLines;
var showDisk = true;
if (showDisk) {
    var getDiskSpace = Promise.promisify(require('diskusage').check);
}
var log = require("./log");

 
var data = require('./fan-data.js');

var app = express();


// static routes that get no further processing
app.use('/img', express.static(__dirname + '/img'));
app.use('/lib', express.static(__dirname + '/lib'));

// say where partials are
hbs.registerPartials(__dirname + '/views/partials');

// put middleware into place
// operative site-wide cookies:
// temperatureUnits: "C" | "F"
app.use(cookieParser());
app.use(function(req, res, next) {
    // fill in default values for common cookies so we don't have to do it elsewhere in the code
    req.cookies.temperatureUnits = req.cookies.temperatureUnits || "F";
    next();
});

// set handlebars as view engine
app.set('view engine', 'html');
app.engine('html', hbs.__express);

// create body parsers
var urlencodedParser = bodyParser.urlencoded({ extended: false });

// register template helpers
hbs.registerHelper("prettifyDate", function(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
});

hbs.registerHelper("stripes", function(index) {
     return (index % 2 === 0 ? "even" : "odd");
});

hbs.registerHelper("formatTemp", function(temp, units) {
    if (units === "F") {
        return toFahrenheitStr(temp);
    }
    return temp;
});

// a bunch of conditionals in templates
hbs.registerHelper('ifCond', function (v1, operator, v2, options) {

    switch (operator) {
        case '==':
            return (v1 == v2) ? options.fn(this) : options.inverse(this);
        case '===':
            return (v1 === v2) ? options.fn(this) : options.inverse(this);
        case '<':
            return (v1 < v2) ? options.fn(this) : options.inverse(this);
        case '<=':
            return (v1 <= v2) ? options.fn(this) : options.inverse(this);
        case '>':
            return (v1 > v2) ? options.fn(this) : options.inverse(this);
        case '>=':
            return (v1 >= v2) ? options.fn(this) : options.inverse(this);
        case '&&':
            return (v1 && v2) ? options.fn(this) : options.inverse(this);
        case '||':
            return (v1 || v2) ? options.fn(this) : options.inverse(this);
        default:
            return options.inverse(this);
    }
});

// define page routes
app.get('/', function(req, res) {
    // ideas for this page
    // - Some average temperature data
    // - yesterday's high and low outside and attic
    // - Some data about how much the fan has been on or not on when it would have been
    // - Some health check data (uptime)
    // - free memory
    // - free storage
    
    function toMinutes(t) {
        return Math.round(t / (1000 * 60));
    }
    
    function toDays(t) {
        return Math.ceil(t / (1000 * 60 * 60 * 24));
    }
    
    function toMBs(num) {
        return addCommas(Math.round(num / (1024 * 1024)));
    }
    
    var templateData = {
        totalMem: addCommas(os.totalmem()),
        freeMem: addCommas(os.freemem()),
        uptime: (os.uptime() / (60 * 60 * 24)).toFixed(1),      // days of uptime
        restarts: [],
        numTemperatures: data.getTemperatureLength(),
        numTemperatureDays: toDays(Date.now() - data.getTemperatureItem(0).t)
    };
    
    var pDiskInfo;
    if (showDisk) {
        pDiskInfo = getDiskSpace("/").then(function(stats) {
            templateData.diskTotalSpace = toMBs(stats.total);
            templateData.diskFreeSpace = toMBs(stats.available);
        });
    } else {
        pDiskInfo = Promise.resolve();
            templateData.diskTotalSpace = 1;
            templateData.diskFreeSpace = 100;
    }
    
    // get other server data info
    
    // see when the fan was last on
    var lastOn = 0, lastOff = 0, cumDays = 0, lastDay = 0, curDay, totalDays, onEventsMax = 0, onEventsToday = 0;
    var intervals = [];
    data.eachEvent(function(event) {
        if (event.event === "on" && event.t > lastOn) {
            lastOn = event.t;
            curDay = new Date(lastOn);
            curDay.setHours(0,0,0,0);
            if (curDay.getTime() !== lastDay) {
                // found an "on" event in a new day
                onEventsToday = 1;
                onEventsMax = Math.max(onEventsMax, onEventsToday);
                ++cumDays;
            } else {
                ++onEventsToday;
                onEventsMax = Math.max(onEventsMax, onEventsToday);
            }
            lastDay = curDay.getTime();
            lastOff = 0;
        }
        // look for the next "off" event after the last "on" event
        if (lastOn && !lastOff && event.event === "off") {
            lastOff = event.t;
            intervals.push(lastOff - lastOn);
        }
        onEventsMax = Math.max(onEventsMax, onEventsToday);
    });
    var firstEvent = data.getFanEvent(0);
    if (firstEvent) {
        totalDays = toDays(Date.now() - firstEvent.t);
    }
    // make sure we always end the fan duration
    if (!lastOff) {
        lastOff = Date.now();
    }
    if (lastOn) {
        templateData.lastOn = new Date(lastOn).toString().replace(/GMT.*$/, "").replace(/:\d+\s*$/, "").replace(" ", ", ");
        templateData.lastOnDuration = toMinutes(lastOff - lastOn);
    }
    if (intervals.length) {
        var longInterval = Math.max.apply(Math, intervals);
        var shortInterval = Math.min.apply(Math, intervals);
        var avgInterval = intervals.reduce(function(sum, value) {
            return sum + value;
        }, 0) / intervals.length;
        templateData.longInterval = toMinutes(longInterval);
        templateData.shortInterval = toMinutes(shortInterval);
        templateData.avgInterval = toMinutes(avgInterval);
        if (totalDays) {
            templateData.percentDays = ((cumDays * 100)/ totalDays).toFixed(1);
        } else {
            templateData.percentDays = 0;
        }
    }
    templateData.onEventsMax = onEventsMax;
    
    // look through log file for unexpected restarts
    var re = /(^.*?Z):\s+fan-control server started on port/;
    var p1 = readLines("/home/pi/logs/fan-control.log", function(line, priorLineRestartMsg) {
        var matches, d;
        matches = line.match(re);
        if (matches) {
            d = new Date(matches[1]);
            // only record results that are not right around 4am
            // and have a "restart attempt" on the previous line
            if ((d.getHours() !== 4 || d.getMinutes() > 5) && priorLineRestartMsg) {
                templateData.restarts.push(d.toString());
            }
        }
        return line.indexOf("Script restart attempt #") !== -1;
    }, false).then(function(serverStarts) {
        
    }).catch(function(err) {
        log(2, "Error reading log file", err);
    });
    
    Promise.all([p1, pDiskInfo]).then(function() {
        res.render('index', templateData);
    });
    
/* 
    var item = data.getTemperatureItem(-1);
    var tempData = {
        tAtticC: item.atticTemp, 
        tAtticF: toFahrenheitStr(item.atticTemp),
        tOutsideC: item.outsideTemp,
        tOutsideF: toFahrenheitStr(item.outsideTemp),
        units: req.cookies.temperatureUnits
    };
    res.render('index', tempData);    
*/    
});

// display log files
// todo - limit log file display size if they are very large
app.get('/logs', function(req, res) {
    var p1 = fs.readFileAsync("/home/pi/logs/fan-control.log");
    var p2 = fs.readFileAsync("/home/pi/logs/fan-control.err");
    Promise.settle([p1, p2]).spread(function(logFile, errFile) {
        var templateData = {logData: "", errData: ""};
        if (logFile.isFulfilled()) {
            templateData.logData = logFile.value();
        }
        if (errFile.isFulfilled()) {
            templateData.errData = errFile.value();
        }
        res.render('logs', templateData);
    }).catch(function(e) {
        log(2, "err getting log files");
        // figure out what to display here
        res.render(e);
    });
});

app.route('/settings')
  .get(function(req, res, next) {
    var tempData = {
        minTemp: toFahrenheit(config.minTemp),
        minOutsideTemp: toFahrenheit(config.minOutsideTemp),
        deltaTemp: toFahrenheitDelta(config.deltaTemp),
        overshoot: toFahrenheitDelta(config.overshoot),
        waitTime: config.waitTime / (1000 * 60),
        outsideAveragingTime: config.outsideAveragingTime / (1000 * 60),
        fanControlReturnToAutoDefault: 30,
        fanState: data.fanOn,
        fanControl: config.fanControl
    };
    
    if (config.fanControl !== "auto" && config.fanControlReturnToAuto !== 0) {
        // calc how many minutes from now
        var minutesFromNow = (config.fanControlReturnToAuto - Date.now()) / (60 * 1000);
        // make sure time is at least 5 minutes into the future
        if (minutesFromNow > 5) {
            tempData.fanControlReturnToAutoDefault = minutesFromNow.toFixed(2);
        }
    }
    
    res.render('settings', tempData);
  }).post(urlencodedParser, function(req, res, next) {
    // post can be either a form post or an ajax call, but it returns JSON either way
    var formatObj = {
        "minOutsideTemp": "FtoC",
        "minTemp": "FtoC",
        "deltaTemp": {type: "FDeltaToC", rangeLow: 2, rangeLowMsg: "Temperature delta must be greater than 4&deg;F"},
        "overshoot": {type: "FDeltaToC", rangeLow: 0.555555554, rangeLowMsg: "Must be greater than 1&deg;F"},
        "waitTime": "minToMs",
        "outsideAveragingTime": "minToMs"
    };
    
    // validate settings and only save items that pass validation
    var results = validate.parseDataObject(req.body, formatObj);
    if (results.err) {
        res.json({status: "validateIssue", err: results.err});
        return;
    }
    
    results = results.output;
    for (var item in results) {
        config[item] = results[item];
    }
    // update our real-time averagers
    if (results.outsideAveragingTime) {
        outsideAverager.setDeltaT(results.outsideAveragingTime);
        atticAverager.setDeltaT(results.outsideAveragingTime);
    }
    config.save().then(function() {
        res.json({status: "ok"});    
    }).catch(function(e) {
        res.json({status: "Config file write failed on server"});
    });
});

app.post('/onoff', urlencodedParser, function(req, res) {
    var formatObj = {
        // value must be more than 5 minutes, can be set to many days if desired
        "fanControlReturnToAuto": {type: "duration", units: "fanControlReturnToAutoUnits", rangeLow: 1000 * 60 * 5, rangeLowMsg: "Time to return to auto must be at least 5 minutes."}
    };
    
    var results = validate.parseDataObject(req.body, formatObj);
    if (results.err) {
        res.json({status: "validateIssue", err: results.err});
        return;
    }
    results = results.output;
    var action = req.body.mode;
    if (results.fanControlReturnToAuto || action === "auto") {
        // calc the actual time in the future to return to auto
        var t = Date.now() + results.fanControlReturnToAuto;
        var status = "ok";
        
        // see which button was sent with the form (e.g. which one was pressed
        if (action === "off") {
            config.fanControlReturnToAuto = t;
            config.fanControl = "off";
            setFan(false, "manual turn off", true);
        } else if (action === "on") {
            config.fanControlReturnToAuto = t;
            config.fanControl = "on";
            setFan(true, "manual turn on", true);
        } else if (action === "auto") {
            config.fanControl = "auto";
            // don't explicitly call setFan() here at all
            // the next temperature point sample will call setFan() for us based on current temperature conditions
        } else {
            status = 'Unknown action: must be "on", "off" or "auto"';
        }
        config.save();
        // return status and new fanControl setting
        res.json({status: status, fanControl: config.fanControl});
    } else {
        res.json({status: "return to auto - invalid value"});
    }
});

app.get('/debug', function(req, res) {
    var tempData = {
        // last hour's worth of data
        temperatures: data.temperatures.slice(-100),
        totalTemps: data.temperatures.length,
        units: req.cookies.temperatureUnits
    };
    res.render('debug', tempData);
});

app.get('/chart', function(req, res) {
    // Temperature data is in this format [item.t, item.atticTemp, item.outsideTemp]
    // add a new point onto the end of the data that represents the current temperatures now
    var temps = data.getTemperatureDataSmall();
    temps.push([Date.now(), atticAverager.getAverage(), outsideAverager.getAverage()]);
    var tempData = {
        temperatures: JSON.stringify(temps),
        onOffData: data.getFanOnOffDataSmallJSON(),
        units: req.cookies.temperatureUnits
    };
    res.render('chart', tempData);
});

// api/
// TODO: make sure proper caching headers are being set here to avoid browser caching on API calls
app.get('/api/status', function(req, res, next) {
    var lastTemps = data.getTemperatureItem(-1);
    var tempData = {
        atticTemp: lastTemps.atticTemp,
        outsideTemp: lastTemps.outsideTemp,
        fan: data.fanOn ? "on" : "off"
    };
    res.json(tempData);
});

app.get('/api/highlow', function(req, res, next) {
    data.getHighLowDataSmall(function(err, d) {
        if (err) {
            res.json(null);
        } else {
            res.json(d);
        }
    });    
});

var server = app.listen(8081, function() {
    log(5, new Date().toISOString() + ": fan-control server started on port 8081");
});

// web sockets handler
var io = require('socket.io').listen(server);
var socketListeners = {
    broadcastTemperatureUpdate: function(atticTemp, outsideTemp) {
        var data = {
            atticTemp: toFahrenheitRound(atticTemp),
            outsideTemp: toFahrenheitRound(outsideTemp)
        };
        this.updates.emit("temperatureUpdateMsg", data);
    },
    broadcastTemperatureUpdateRaw: function(atticTempRaw, outsideTempRaw, atticTemp, outsideTemp) {
        // we broadcast all raw (unaveraged temperatures to the 'raw' room in the /updates namespace)
        var data = {
            t: Date.now(),
            atticTemp: toFahrenheitRound(atticTemp),
            outsideTemp: toFahrenheitRound(outsideTemp),
            atticTempAvg: toFahrenheit(atticTemp),
            outsideTempAvg: toFahrenheit(outsideTemp),
            atticTempRaw: toFahrenheit(atticTempRaw),
            outsideTempRaw: toFahrenheit(outsideTempRaw)
        };
        this.updates.to('raw').emit("temperatureUpdateRawMsg", data);
    },
    broadcastFanUpdate: function(data) {
        this.updates.emit("fanUpdateMsg", data ? "On" : "Off");
    }
};

socketListeners.updates = io.of('/updates').on('connection', function(socket) {
    // upon connection, send our last temperature reading
    var lastTemps = data.getTemperatureItem(-1);    
    if (lastTemps) {
        socket.emit("temperatureUpdateMsg", {atticTemp: toFahrenheitRound(lastTemps.atticTemp), outsideTemp: toFahrenheitRound(lastTemps.outsideTemp)});
    }
    // send initial state of the fan
    socket.emit("fanUpdateMsg", data.fanOn ? "On" : "Off");
    
    // listen to events coming from the client
    socket.on("joinRoom", function(room) {
        if (room === "raw") {
            socket.join("raw");
        }
    });
    socket.on("leaveRoom", function(room) {
        if (room === "raw") {
            socket.leave("raw");
        }
    });
});


// convert degrees Celsius to Fahrenheit
function toFahrenheit(c) {
    return (+c * 9 / 5) + 32;
}

function toFahrenheitRound(c) {
    return Math.round(((c * 9 / 5) + 32) * 100) / 100;
}


function toFahrenheitDelta(c) {
    return (+c * 9) / 5;
}

function toCelsius(f) {
    return (+f - 32) * 5 / 9;
}

function toCelsiusDelta(f) {
    return +f * 5 / 9;
}
// convert degrees Celsius to Fahrenheit
// return string form rounded to one decimal
function toFahrenheitStr(c) {
    return toFahrenheit(c).toFixed(2);
}



// returns a promise that eventually returns the temp
function getTemperature(id) {
    return new Promise(function(resolve, reject) {
        var fname = "/sys/bus/w1/devices/" + id + "/w1_slave";
        fs.readFile(fname,  function(err, data) {
            if (err || !data) {
                log(1, "failed to read temperature file: " + fname, err);
                reject("filename (" + fname + ") read failed.");
                return;
            }
            
            // sample file content
            // 91 01 4b 46 7f ff 0f 10 25 : crc=25 YES
            // 91 01 4b 46 7f ff 0f 10 25 t=25062
            // temperate is in thousandths of a degree Celsius
            var lines = data.toString().split("\n");
            if (lines.length >= 2 && lines[0].match(/YES\s*$/)) {
                // crc passed
                var match = lines[1].match(/\st=(\d+)\s*$/);
                if (match) {
                    // convert to number and return it
                    resolve(+match[1] / 1000);
                } else {
                    var msg = "didn't find t=xxxxx, " + lines[2];
                    log(1, msg);
                    reject(msg);
                    return;
                }
            } else {
                // no valid temperature here
                log(1, "didn't find 'YES'", lines[1]);
                reject("didn't find 'YES'");
                return;
            }
        });
    });
}

// data to store
// Round all temps to 0.1 degree C
// fan on/off times for N years (nice to compare year to year and do some analysis so perhaps 3 years)
// most recent temperature always available
// All temperature changes for N days (perhaps 7 days)

// Fan algorithm
// minTemp = must be hotter than this in the attic or fan will not come on (suggest 90 degrees F)
// minOutsideTemp = outside temp must be hotter than this or fan will not come on
// deltaTemp = delta between attic and outside temp that will trigger the fan (suggest 10 degrees F)
// overshootDegrees = fan will stay on until temp diff is deltaTemp - overshootDegrees (suggest 2 degrees F)
// Temperature must exceed deltaTemp for 10 minutes before turning the fan back on

var config = {
    thermometerInfo: {
        outsideID: "28-000005cf5a54",
        atticID: "28-000005e947e8",
        atticCalibration: 0,                    // correction to apply to attic temperature
        outsideCalibration: 0                   // correction to apply to outside temperature
    },
    // temporarily set low for testing
    minTemp: 29.444,                            // 29.444C (85F)
    minOutsideTemp: 32.2222,                    // 90F
    deltaTemp: 3.33333333333333,                // 6F
    overshoot: 0.55555555555555,                // ~1F
    waitTime: 10 * 60 * 1000,                   // 10 minutes (min time to wait from turn off before turning on)
    fanEventRetentionDays: (365 * 3) + 1,       // retain N days of fan on/off data
    temperatureRetentionDays: 14,                // retain N days of temperature data (starting from next midnight transition)
    temperatureRetentionMaxItems: 10000,        // max temp points to retain (to prevent runaway memory usage)
    dataSaveTime: 1000 * 60 * 60,               // save data to SD once per hour    
    fanPorts: [18, 16],                         // gpio ports to turn the fans on/off (this is Pi pin numbering, not Broadcom numbering)
    fanSeparationTime: 20 * 1000,               // time delay between switching each fan
    fanControl: "auto",                         // "on", "off", "auto"
    fanControlReturnToAuto: 0,                  // time that fan control should return to auto
                                                // 0 is never return, otherwise it's a time when control should go back to auto
    outsideAveragingTime: 3 * 60 * 1000,        // 3 minutes - time (ms) to average the temperatures over
    minRecordDiff: 0.2,                         // min temp difference before recording the data
    
    configFilename: "/home/pi/fan-control.cfg",
    dataFilename: "/home/pi/fan-control-data.txt",
    highLowFilename: "/home/pi/hi-lo.txt",

    // returns a promise
    save: function() {
        return fs.writeFileAsync(this.configFilename, JSON.stringify(this), 'utf8').catch(function(e) {
            log(1, "Error saving config file");
        });
    },
    // this is only done synchronously because it's just done at startup
    load: function() {
        try {
            var data;
            var buffer = fs.readFileSync(this.configFilename, 'utf8');
            if (buffer) {
                data = JSON.parse(buffer);
                for (var prop in data) {
                    // only store properties we know about
                    if (config.hasOwnProperty(prop)) {
                        config[prop] = data[prop];
                    }
                }
            }
            if (!this.thermometerInfo.atticID || !this.thermometerInfo.outsideID) {
                log(1, "Missing thermometerInfo.atticID or thermometerInfo.outsideID");
                process.exit(1);
            }
            // make sure these two calibration factors exist
            this.thermometerInfo.atticCalibration = this.thermometerInfo.atticCalibration || 0;
            this.thermometerInfo.outsideCalibration = this.thermometerInfo.outsideCalibration || 0;
        } catch(e) {
            // avoid error logging if the only issue is that the file doesn't exist
            if (e.code !== 'ENOENT') {
                log(1, "Error reading config or parsing JSON. ", e);
            }
        }
    }
};

// read config from SD card upon initialization
config.load();

// open the GPIO ports and then read their value
// Note: the way this code is written, the GPIO ports may not be ready for about 250 ms after this executes
// Any code that attempts to use them must wait at least that long
(function() {
    config.fanPorts.forEach(function(port) {
        gpio.openGrab(port, function(err) {
            if (err) {
                log(2, "error opening gpio port " + port + " at startup");
            }
            gpio.read(port, function(err, value) {
                if (err) {
                    log(2, "error reading gpio port " + port + " at startup");
                } else {
                    // at least one fan is on so indicate that in our data
                    if (value) {
                        data.fanOn = true;
                        // hmmm, found the fan on so record it as so
                        data.addFanOnOffEvent("on", "GPIO port found on at startup");
                    }
                }
            });
        });
    });
})();

data.init({
    writeTime: config.dataSaveTime,
    temperatureRetentionMaxItems: config.temperatureRetentionMaxItems,
    temperatureRetentionDays: config.temperatureRetentionDays,
    fanEventRetentionDays: config.fanEventRetentionDays,
    filename: config.dataFilename,
    highLowFilename: config.highLowFilename
});        


// setup process exit handlers so we write our data
process.on('exit', function(code) {
    log(4, "Exiting process with code: " + code);
    
    // synchronously turn off both fans upon shut-down
    setFanHardwareOnOff(false, 0, true);
    
    // make sure there's an off event when server shuts down
    data.addFanOnOffEvent("off", "process shutdown");
    
    // write data synchronously here
    data.writeData(config.dataFilename, true);
    
}).on('SIGINT', function() {
    log(4, "SIGINT signal received - exiting");
    if (!data.getDataBlock()) {
        process.exit(2);
    }
}).on('SIGTERM', function() {
    log(4, "SIGTERM signal received - exiting");
    if (!data.getDataBlock()) {
        process.exit(3);
    }
});

//returns {state: bool, reason: str}
function checkFanAction(atticTemp, outsideTemp) {
    var reasonExtra = "";
    var curTime = Date.now();
    // if it isn't on auto
    if (config.fanControl !== "auto" && config.fanControlReturnToAuto !== 0) {
        // check if we should return to "auto"
        if (curTime >= config.fanControlReturnToAuto) {
            config.fanControl = "auto";
            config.fanControlReturnToAuto = 0;
            reasonExtra = "return to auto - ";
        }
    }
    
    if (config.fanControl === "off") {
        // make sure fan is off
        return {state: false, reason: "manual off"};
    } else if (config.fanControl === "on") {
        // make sure fan is on
        return {state: true, reason: "manual on"};
    }
    
    // from here on is the "auto" behavior
    
    var delta = atticTemp - outsideTemp;
    
    if (data.fanOn) {
        // when fan is on, it's allowed to run down to 
        //   config.minTemp - config.overshoot or config.minOutsideTemp - config.overshoot
        // this is to keep it from turning back on right away if there's a 
        //   little temperature rebound when the fan is turned off
        if (atticTemp <= (config.minTemp - config.overshoot) || (outsideTemp <= (config.minOutsideTemp - config.overshoot))) {
            return {state: false, reason: reasonExtra + "attic temp not above minTemp - overshoot or minOutsideTemp - overshoot"};
        }
        
        // if fan already on, see if we should turn it off
        // delta has to be less than config.deltaTemp - config.overshoot to turn it off
        // in other words, the attic has to cool down at least config.overshoot degrees in order
        // to decide to now turn the fan off.  This keeps it from turning on at config.deltaTemp,
        // cooling down 0.1 degrees and then turning off (often called hysteresis)
        if (delta <= (config.deltaTemp - config.overshoot)) {
            return {state: false, reason: reasonExtra + "delta temp too low"};
        }
        
    } else {
        // when fan is off, never turn it on if attic temp is below config.minTemp or if outside temp is below config.minOutsideTemp
        if (atticTemp <= config.minTemp || outsideTemp <= config.minOutsideTemp) {
            return {state: false, reason: reasonExtra + "attic temp or outside temp not above minTemp"};
        }
    
        // fan is off, see if we should turn it on
        // delta has to be more than config.deltaTemp to turn it on
        if (delta >= config.deltaTemp) {
            return {state: true, reason: reasonExtra + "delta temp exceeded"};
        }
    }
    // don't change fan setting, stay with current setting
    return {state: data.fanOn, reason: "no change"};
}

// set the fan to the desired setting
// pass true to make sure the fan is ON
// pass false to make sure the fan is OFF
// The ignoreTime argument says to change the fan now, without regard for the data.lastFanChangetime
// ignoreTime is normally not passed except for manual override

function setFan(fanOn, reason, ignoreTime) {
    var curTime = Date.now();
    if (fanOn !== data.fanOn) {
        // if we are turning off, we can act right away
        // if we are turning on, we must wait at least config.waitTime from when we turned it off
        // this is to avoid any rapid cycling if temp readings go nuts
        if (!fanOn || ignoreTime || (curTime - data.lastFanChangeTime) >= config.waitTime) {
        
            // Set the fan hardware here
            // Note that setting the actual fans is asynchronous (delay between changing them too)
            // but we can act like it already happened so it shouldn't matter to us
            setFanHardwareOnOff(fanOn, config.fanSeparationTime);
            socketListeners.broadcastFanUpdate(fanOn);
            // and record when we changed it
            data.fanOn = fanOn;
            data.lastFanChangeTime = curTime;
            // add fan change event
            data.addFanOnOffEvent(fanOn ? "on" : "off", reason);
            log(3, "fan changed to " + (fanOn ? "on" : "off"));
        } else {
            log(3, "fan turn on holding for waitTime");
        }
    }
}

function setFanHardwareOnOff(on, delay, sync) {
    // make sure val is 1 or 0
    var val = on ? 1 : 0;
    var cntr = 0;
    var fanPorts = config.fanPorts;
    
    // ports are assumed to already be opened here by startup code
    
    function nextAsync() {
        if (cntr < fanPorts.length) {
            var pin = fanPorts[cntr];
            gpio.write(pin, val, function(err) {
                if (err) {
                    log(1, "gpio.write() error", err);
                } else {
                    ++cntr;
                    if (delay) {
                        setTimeout(nextAsync, delay);
                    } else {
                        nextAsync();
                    }
                }
            });
        }
    }
    
    
    // sync is only used on shut-down
    // delay value is not processed when sync is used
    if (sync) {
        for (; cntr < fanPorts.length; cntr++) {
            try {
                gpio.writeSync(fanPorts[cntr], val);
            } catch(e) {
                log(1, "Error on gpio.writeSync()");
            }
        }
    } else {
        // start the first one asynchronously
        nextAsync();
    }
}


var outsideAverager = new timeAverager(config.outsideAveragingTime);
var atticAverager = new timeAverager(config.outsideAveragingTime);

var consecutivePollErrors = 0;
function poll() {
    Promise.all([getTemperature(config.thermometerInfo.atticID), getTemperature(config.thermometerInfo.outsideID)]).spread(function(atticTempRaw, outsideTempRaw) {
        var minDiff = config.minRecordDiff, recordTemp = true, atticTemp, outsideTemp;
        
        // add in calibration factor
        atticTempRaw += config.thermometerInfo.atticCalibration;
        outsideTempRaw += config.thermometerInfo.outsideCalibration;

        // put both our data points into averagers to smooth out any data glitches
        // then round to two decimal points (which is likely more precision than there really is)
        outsideTemp = Math.round(outsideAverager.add(outsideTempRaw) * 100) / 100;
        atticTemp = Math.round(atticAverager.add(atticTempRaw) * 100) / 100;
        
        // share raw temperatures
        socketListeners.broadcastTemperatureUpdateRaw(atticTempRaw, outsideTempRaw, atticTemp, outsideTemp);

        var lastTemps = data.getTemperatureItem(-1);
        if (lastTemps) {
            // if neither temp has changed enough since we last saved a temp, then don't record it
            recordTemp = Math.abs(lastTemps.atticTemp - atticTemp) >= minDiff || Math.abs(lastTemps.outsideTemp - outsideTemp) >= minDiff;
        }
        if (recordTemp) {
            data.addTemperature(atticTemp, outsideTemp);
            // let any listeners know we have a newly recorded temperature
            socketListeners.broadcastTemperatureUpdate(atticTemp, outsideTemp);
            // age any data that needs to be thrown away
            data.ageData();
        }

        // make sure fan setting is set appropriately
        var result = checkFanAction(atticTemp, outsideTemp);
        setFan(result.state, result.reason);
        
        // reset error counter
        consecutivePollErrors = 0;
        
        /*
        log(1, new Date().toString().replace(/\s*GMT.*$/, "") + ": attic temp = " + atticTemp + 
            ", outside temp = " + outsideTemp + ", len=" + data.getTemperatureLength() + 
            ", data recorded = " + recordTemp);
        */
    }, function(err) {
        log(1, "promise rejected on temperature fetch: " + err);
        ++consecutivePollErrors;
        // after a bunch of consecutive temperature polling errors, we shut-down the process to let it restart
        if (consecutivePollErrors > 20) {
            log(1, "consecutivePollErrors exceeded threshold, restarting process");
            shutdown(1);
        }
        // FIXME: what to do if every restart has this same issue
    });
}

// We don't want to start polling temperatures or recording them until we know that the
// system time is correct (it will mess up the recorded data)
// To do that, we get the current time from an ntp server and compare it to the current system time
var validTime = require("./valid-time");

// look for an accuracy of 2 minutes or better and keep checking forever
// note: this will require a working internet connection before it will start polling the temperatures
validTime.waitForAccurateSystemTime(2 * 60 * 1000, 0).then(function() {
    poll();
    data.temperatureInterval = setInterval(poll, 10 * 1000);
}, function(err) {
    log(1, err);
    process.exit(1);
});

function shutdown(exitCode) {
    var cntr = 20;
    // stop our polling interval
    clearInterval(data.temperatureInterval);
    
    // force fan hardware off and write it synchronously
    setFanHardwareOnOff(false, 0, true);
    
    // save data and exit process
    function exit() {
        // write data synchronously
        data.writeData(config.dataFilename, true);
        process.exit(exitCode);
    }
    
    // see if we can write the data now
    function check() {
        if (!data.getDataBlock() || cntr < 0) {
            exit();
        } else {
            log(4, "ran into dataBlock on shutdown - waiting for block to clear");
            --cntr;
            // check again in 30 seconds
            setTimeout(check, 30 * 1000);
        }
    }
    check();
}


// kill the server process at 4am each night
// the forever daemon will restart it after we stop it
(function() {
    var exitTime = new Date();
    if (exitTime.getHours() < 4) {
        exitTime.setHours(4, 0, 0, 0);
    } else {
        exitTime.setHours(28, 0, 0, 0);
    }
    // calc amount of time until restart
    var t = exitTime.getTime() - Date.now();
    setTimeout(function() {
        log(4, "daily 4am shutdown");
        shutdown(1);
    }, t);
})();



// Interesting observation.  When your app exists, the GPIO pins you were controlling
// hold their value forever (until the Pi is shutdown or rebooted).  We may need to turn things
// off when we exit.


// debug code to turn the LED on and off
/*
(function() {
    var lastValue = 0;
    // Pi pins 16 and 18 are the two we're going to use to control the fans
    var pin = 16;

    setInterval(function() {
        ++lastValue;
        var newVal = lastValue %2;
        gpio.write(pin, newVal, function(err) {        // Set pin 16 high (1)
            if (err) {
                log(2, "gpio.write error: ", err);
                return;
            }
        });        
    }, 3000);
})();
*/

function addCommas(str) {
    var parts = (str + "").split("."),
        main = parts[0],
        len = main.length,
        output = "",
        i = len - 1;
    
    while(i >= 0) {
        output = main.charAt(i) + output;
        if ((len - i) % 3 === 0 && i > 0) {
            output = "," + output;
        }
        --i;
    }
    // put decimal part back
    if (parts.length > 1) {
        output += "." + parts[1];
    }
    return output;
}
