"use strict";
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var express = require('express');
var hbs = require('hbs');
var gpio = require('./pi-gpio');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');
var validate = require('./validate');
var timeAverager = require('./averager').timeAverager;
var session = require('express-session');
var flash = require('connect-flash');
 
var data = require('./fan-data.js');

var app = express();


// static routes that get no further processing
app.use('/lib', express.static(__dirname + '/lib'));
app.use('/img', express.static(__dirname + '/img'));

// say where partials are
hbs.registerPartials(__dirname + '/views/partials');

// put middleware into place
// operative site-wide cookies:
// temperatureUnits: "C" | "F"
app.use(cookieParser());
app.use(session({secret: 'fanControl', saveUninitialized: true, resave: true}));
app.use(flash());
app.use(function(req, res, next) {
    // fill in default values for common cookies so we don't have to do it elsewhere in the code
    req.cookies.temperatureUnits = req.cookies.temperatureUnits || "C";
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
    var item = data.getTemperatureItem(-1);
    var tempData = {
        tAtticC: item.atticTemp, 
        tAtticF: toFahrenheitStr(item.atticTemp),
        tOutsideC: item.outsideTemp,
        tOutsideF: toFahrenheitStr(item.outsideTemp),
        units: req.cookies.temperatureUnits
    };
    res.render('index', tempData);    
});

app.get('/index', function(req, res) {
    res.render('index', {test: "Hello World"});
});

// add data to a data structure (usually a handlebars data structure)
// from the hbsExtra flash key
function getHbsItems(req, data) {
    var extra = req.flash('hbsExtra'), obj, key;
    if (extra) {
        for (var i = 0; i < extra.length; i++) {
            obj = extra[i];
            for (key in obj) {
                data[key] = obj[key];
            }
        }
    }
}

// item is an object with key value pairs that will be added to the handlebars data structure
function addHbsItem(req, item) {
    req.flash('hbsExtra', item);
}

app.route('/settings')
  .get(function(req, res, next) {
    var tempData = {
        minTemp: toFahrenheit(config.minTemp),
        deltaTemp: toFahrenheitDelta(config.deltaTemp),
        overshoot: toFahrenheitDelta(config.overshoot),
        waitTime: config.waitTime / (1000 * 60),
        outsideAveragingTime: config.outsideAveragingTime / (1000 * 60),
        fanControlReturnToAutoDefault: 30,
        fanState: data.fanOn,
        fanControl: config.fanControl
    };
    res.render('settings', tempData);
  }).post(urlencodedParser, function(req, res, next) {
    // post can be either a form post or an ajax call, but it returns JSON either way
    var formatObj = {
        "minTemp": "FtoC",
        "deltaTemp": {type: "FDeltaToC", rangeLow: 2},
        "overshoot": {type: "FDeltaToC", rangeLow: 1},
        "waitTime": "minToMs",
        "outsideAveragingTime": "minToMs"
    };
    
    // validate settings and only save items that pass validation
    var results = validate.parseDataObject(req.body, formatObj);
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
        // value must be more than 5 minutes, less than 12 hours
        "fanControlReturnToAuto": {type: "minToMs", preRangeLow: 1, preRangeHigh: 12 * 60}
    };
    
    var results = validate.parseDataObject(req.body, formatObj);
    var action = req.body.action;
    if (results.fanControlReturnToAuto || action === "auto") {
        // calc the actual time in the future to return to auto
        var t = Date.now() + results.fanControlReturnToAuto;
        var status = "ok";
        
        // see which button was sent with the form (e.g. which one was pressed
        if (action === "off") {
            config.fanControlReturnToAuto = t;
            config.fanControl = "off";
            setFan(false, true);
        } else if (action === "on") {
            config.fanControlReturnToAuto = t;
            config.fanControl = "on";
            setFan(true, true);
        } else if (action === "auto") {
            config.fanControl = "auto";
            // don't explicitly call setFan() here at all
            // the next temperature point sample will call setFan() for us based on current temperature conditions
        } else {
            status = 'Unknown action: must be "on", "off" or "auto"';
        }
        config.save();
        res.json({status: status});
    }
});
    
app.get('/debug', function(req, res) {
    var tempData = {
        temperatures: data.temperatures,
        units: req.cookies.temperatureUnits
    };
    res.render('debug', tempData);
});

app.get('/chart', function(req, res) {
    var tempData = {
        // todo - trim the data down
        temperatures: JSON.stringify(data.temperatures),
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

var server = app.listen(8081, function() {
    console.log(new Date().toString() + ": fan-control server started on port 8081");
});

// web sockets handler
var io = require('socket.io').listen(server);

// this line of code gets a list of all currently connected websockets that we can broadcast to
// this is an object with a key of the id and value of the socket object
// "/" is the default namespace
// var clients = io.of("/").connected;


var activeSockets = {};
io.sockets.on('connection', function (socket) {
    console.log(socket.id + ": socket connect");
    // add socket to our active sockets list
    activeSockets[socket.id] = socket;
    
    // register for disconnect
    // so we can remove it from our list
    socket.on('disconnect', function(socket) {
        console.log(socket.id + ": socket disconnect");
        var index = activeSockets.indexOf(socket);
        if (index !== -1) {
            activeSockets.splice(index, 1);
        }
    });
    socket.on("info", function() {
        socket.emit("hello");
    });
});




// convert degrees Celsius to Fahrenheit
function toFahrenheit(c) {
    return (+c * 9 / 5) + 32;
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
                console.log("failed to read temperature file: " + fname);
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
                    console.log("didn't find t=xxxxx");
                    reject("didn't find t=xxxxx");
                    return;
                }
            } else {
                // no valid temperature here
                console.log("didn't find 'YES'");
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
    deltaTemp: 5.6,                             // 10F
    overshoot: 1,                               // ~2F
    waitTime: 10 * 60 * 1000,                   // 10 minutes (min time to wait from turn off before turning on)
    fanEventRetentionDays: (365 * 3) + 1,       // retain N days of fan on/off data
    temperatureRetentionDays: 7,                // retain N days of temperature data (starting from next midnight transition)
    temperatureRetentionMaxItems: 10000,        // max temp points to retain (to prevent runaway memory usage)
    dataSaveTime: 1000 * 60 * 60,               // save data to SD once per hour    
    fanPorts: [18, 16],                         // gpio ports to turn the fans on/off (this is Pi pin numbering, not Broadcom numbering)
    fanSeparationTime: 20 * 1000,               // time delay between switching each fan
    fanControl: "auto",                         // "on", "off", "auto"
    fanControlReturnToAuto: 0,                  // time that fan control should return to auto
                                                // 0 is never return, otherwise it's a time when control should go back to auto
    outsideAveragingTime: 3 * 60 * 1000,        // 3 minutes - time (ms) to average the temperatures over
    
    configFilename: "/home/pi/fan-control.cfg",
    dataFilename: "/home/pi/fan-control-data.txt",

    // returns a promise
    save: function() {
        return fs.writeFileAsync(this.configFilename, JSON.stringify(this), 'utf8').catch(function(e) {
            console.log("Error saving config file");
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
                console.log("Missing thermometerInfo.atticID or thermometerInfo.outsideID");
                process.exit(1);
            }
            // make sure these two calibration factors exist
            this.thermometerInfo.atticCalibration = this.thermometerInfo.atticCalibration || 0;
            this.thermometerInfo.outsideCalibration = this.thermometerInfo.outsideCalibration || 0;
        } catch(e) {
            // avoid error logging if the only issue is that the file doesn't exist
            if (e.code !== 'ENOENT') {
                console.log("Error reading config or parsing JSON. ", e);
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
                console.log("error opening gpio port " + port + " at startup");
            }
            gpio.read(port, function(err, value) {
                if (err) {
                    console.log("error reading gpio port " + port + " at startup");
                } else {
                    console.log("read GPIO port " + port + " with value: " + value);
                    // at least one fan is on so indicate that in our data
                    if (value) {
                        data.fanOn = true;
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
    filename: config.dataFilename
});        


// setup process exit handlers so we write our data
process.on('exit', function(code) {
    console.log("Exiting process with code: " + code);
    
    // write data synchronously here
    data.writeData(config.dataFilename, true);
    
    // synchronously turn off both fans upon shut-down
    setFanHardwareOnOff(false, 0, true);
    
}).on('SIGINT', function() {
    console.log("SIGINT signal received - exiting");
    process.exit(2);
}).on('SIGTERM', function() {
    console.log("SIGTERM signal received - exiting");
    process.exit(3);
});

// returns true for fan should be on
// returns false for fan should be off
function checkFanAction(atticTemp, outsideTemp) {
    var curTime = Date.now();
    // if it isn't on auto
    if (config.fanControl !== "auto" && config.fanControlReturnToAuto !== 0) {
        // check if we should return to "auto"
        if (curTime >= config.fanControlReturnToAuto) {
            config.fanControl = "auto";
            config.fanControlReturnToAuto = 0;
        }
    }
    
    if (config.fanControl === "off") {
        // make sure fan is off
        return false;
    } else if (config.fanControl === "on") {
        // make sure fan is on
        return true;
    }
    
    // from here on is the "auto" behavior
    
    var delta = atticTemp - outsideTemp;
    
    // if attic is simply not hot, then don't turn the attic fan on
    if (atticTemp <= config.minTemp) {
        return false;
    }
    
    if (data.fanOn) {
        // if fan already on, see if we should turn it off
        // delta has to be less than config.deltaTemp - config.overshoot to turn it off
        // in other words, the attic has to cool down at least config.overshoot degrees in order
        // to decide to now turn the fan off.  This keeps it from turning on at config.deltaTemp,
        // cooling down 0.1 degrees and then turning off (often called hysteresis)
        if (delta <= (config.deltaTemp - config.overshoot)) {
            return false;
        }
        
    } else {
        // fan is off, see if we should turn it on
        // delta has to be more than config.deltaTemp to turn it on
        if (delta >= config.deltaTemp) {
            return true;
        }
    }
    // don't change fan setting, stay with current setting
    return data.fanOn;
}

// set the fan to the desired setting
// pass true to make sure the fan is ON
// pass false to make sure the fan is OFF
// The ignoreTime argument says to change the fan now, without regard for the data.lastFanChangetime
// ignoreTime is normally not passed except for manual override

function setFan(fanOn, ignoreTime) {
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
        
            // and record when we changed it
            data.fanOn = fanOn;
            data.lastFanChangeTime = curTime;
            // add fan change event
            data.fanOnOffEvents.push({t: Date.now(), event: fanOn ? "on" : "off"});
            console.log("fan changed to " + (fanOn ? "on" : "off"));
        } else {
            console.log("fan turn on holding for waitTime");
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
                    console.log("gpio.write() error", err);
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
                console.log("Error on gpio.writeSync()");
            }
        }
    } else {
        // start the first one asynchronously
        nextAsync();
    }
}


var outsideAverager = new timeAverager(config.outsideAveragingTime);
var atticAverager = new timeAverager(config.outsideAveragingTime);

function poll() {
    Promise.all([getTemperature(config.thermometerInfo.atticID), getTemperature(config.thermometerInfo.outsideID)]).spread(function(atticTemp, outsideTemp) {
        var minDiff = 0.06, recordTemp = true;
        
        // add in calibration factor
        atticTemp += config.thermometerInfo.atticCalibration;
        outsideTemp += config.thermometerInfo.outsideCalibration;

        // put both our data points into averagers to smooth out any data glitches
        // then round to two decimal points (which is likely more precision than there really is)
        outsideTemp = Math.round(outsideAverager.add(outsideTemp) * 100) / 100;
        atticTemp = Math.round(atticAverager.add(atticTemp) * 100) / 100;

        var lastTemps = data.getTemperatureItem(-1);
        if (lastTemps) {
            // if neither temp has changed enough since we last saved a temp, then don't record it
            recordTemp = Math.abs(lastTemps.atticTemp - atticTemp) >= minDiff || Math.abs(lastTemps.outsideTemp - outsideTemp) >= minDiff;
        }
        if (recordTemp) {
            data.addTemperature(atticTemp, outsideTemp);
        }

        // make sure fan setting is set appropriately
        setFan(checkFanAction(atticTemp, outsideTemp));
        
        // age any data that needs to be thrown away
        data.ageData();
        /*
        console.log(new Date().toString().replace(/\s*GMT.*$/, "") + ": attic temp = " + atticTemp + 
            ", outside temp = " + outsideTemp + ", len=" + data.getTemperatureLength() + 
            ", data recorded = " + recordTemp);
        */
    }, function(err) {
        console.log("promise rejected on temperature fetch: " + err);
    });
}

poll();
data.temperatureInterval = setInterval(poll, 10 * 1000);


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
    setTimeout(function(){
        // make sure data is written out
        data.writeData(config.dataFilename, true);
        
        console.log("daily 4am exit - forever daemon should restart us");
        process.exit(1);
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
                console.log("gpio.write error: ", err);
                return;
            }
        });        
    }, 3000);
})();
*/