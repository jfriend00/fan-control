"use strict";
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var express = require('express');
var hbs = require('hbs');
var gpio = require('gpio');
var cookieParser = require('cookie-parser');

var data = require('./fan-data.js');

var app = express();

// static routes that get no further processing
app.use('/lib', express.static(__dirname + '/lib'));
app.use('/img', express.static(__dirname + '/img'));

// put middleware into place
// operative site-wide cookies:
// temperatureUnits: "C" | "F"
app.use(cookieParser());
app.use(function(request, response, next) {
    // fill in default values for common cookies so we don't have to do it elsewhere in the code
    request.cookies.temperatureUnits = request.cookies.temperatureUnits || "C";
    next();
});

// set handlebars as view engine
app.set('view engine', 'html');
app.engine('html', hbs.__express);

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

// define page routes
app.get('/', function(request, response) {
    var item = data.getTemperatureItem(-1);
    var tempData = {
        tAtticC: item.atticTemp, 
        tAtticF: toFahrenheitStr(item.atticTemp),
        tOutsideC: item.outsideTemp,
        tOutsideF: toFahrenheitStr(item.outsideTemp),
        units: request.cookies.temperatureUnits
    };
    response.render('index', tempData);    
});

// define our page routes
app.get('/index', function(request, response) {
    response.render('index', {test: "Hello World"});
});

app.get('/settings', function(request, response) {
    response.render('settings');
});

app.get('/debug', function(request, response) {
    var tempData = {
        temperatures: data.temperatures,
        units: request.cookies.temperatureUnits
    };
    response.render('debug', tempData);
});

app.get('/chart', function(request, response) {
    var tempData = {
        // todo - trim the data down
        temperatures: JSON.stringify(data.temperatures),
        units: request.cookies.temperatureUnits
    };
    response.render('chart', tempData);
});

var server = app.listen(8081, function() {
    console.log("Server running on port 8081");
});



// convert degrees Celsius to Fahrenheit
function toFahrenheit(c) {
    return (c * 9 / 5) + 32;
}

// convert degrees Celsius to Fahrenheit
// return string form rounded to one decimal
function toFahrenheitStr(c) {
    return toFahrenheit(c).toFixed(1);
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
        atticID: "28-000005cf5a54",
        outsideID: "28-000005e947e8",
        atticCalibration: 0,                    // correction to apply to attic temperature
        outsideCalibration: 0                   // correction to apply to outside temperature
    },
    // temporarily set low for testing
    minTemp: 10,                                // 32.22C (90F)
    deltaTemp: 5.6,                             // 10F
    overshoot: 1,                               // ~2F
    waitTime: 10 * 60 * 1000,                   // 10 minutes (min time to wait from turn off before turning on)
    fanEventRetentionDays: (365 * 3) + 1,       // retain N days of fan on/off data
    temperatureRetentionDays: 7,                // retain N days of temperature data (starting from next midnight transition)
    temperatureRetentionMaxItems: 5000,         // max temp points to retain (to prevent runaway memory usage)
    dataSaveTime: 1000 * 60 * 60,               // save data to SD once per hour    
    
    configFilename: "/home/pi/fan-control.cfg",
    dataFilename: "/home/pi/fan-control-data.txt",
    
    saveConfig: function() {
        try {
            fs.writeFile(this.configFilename, 'utf8', JSON.stringify(this), function(err) {
                if (err) throw err;
            });
        } catch(e) {
            console.log("Error saving config file");
        }
    },
    // this is only done synchronously because it's just done at startup
    readConfig: function() {
        try {
            var data;
            var buffer = fs.readFileSync(this.configFilename, 'utf8');
            if (buffer) {
                data = JSON.parse(buffer);
                for (var prop in data) {
                    if (prop in config) {
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
config.readConfig();

// FIXME: switch to using the actual config.dataSaveTime
data.init({
    writeTime: 15 * 1000,
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
}).on('SIGINT', function() {
    console.log("SIGINT signal received - exiting");
    process.exit(2);
});

// returns true for fan should be on
// returns false for fan should be off
function checkFanAction(atticTemp, outsideTemp) {
    var delta = atticTemp - outsideTemp;
    
    // if attic is simply not hot, then don't turn the attic fan on
    if (atticTemp <= config.minTemp) {
        return false;
    }
    
    if (data.fanOn) {
        // if fan already on, see if we should turn it off
        // delta has to be less than config.deltaTemp - config.overshoot to turn it off
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
    return (data.fanOn);
}

// set the fan to the desired setting
function setFan(fanOn) {
    var curTime = Date.now();
    if (fanOn !== data.fanOn) {
        // if we are turning off, we can act right away
        // if we are turning on, we must wait at least config.waitTime from when we turned it off
        // this is to avoid any rapid cycling if temp readings go nuts
        if (!fanOn || (curTime - data.lastFanChangeTime) >= config.waitTime) {
            // set the fan hardware here
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

function poll() {
    Promise.all([getTemperature(config.thermometerInfo.atticID), getTemperature(config.thermometerInfo.outsideID)]).then(function(temps) {
        var recordTemp = true,
            // round to one decimal and add in calibration factor
            atticTemp = Math.round((temps[0] + config.thermometerInfo.atticCalibration) * 10) / 10, 
            outsideTemp = Math.round((temps[1] + config.thermometerInfo.outsideCalibration) * 10) / 10;
        
        
        var lastTemps = data.getTemperatureItem(-1);
        if (lastTemps) {
            // if neither temp has changed since we last saved a temp, then don't record it
            // temps are rounded to 0.1 degree C so it has to change a meaningful amount to get recorded
            if (lastTemps.atticTemp === atticTemp && lastTemps.outsideTemp === outsideTemp) {
                recordTemp = false;
            }
        }
        if (recordTemp) {
            data.addTemperature(atticTemp, outsideTemp);
        }

        // make sure fan setting is set appropriately
        setFan(checkFanAction(atticTemp, outsideTemp));
        
        // age any data that needs to be thrown away
        data.ageData();
        
        console.log(new Date().toString().replace(/\s*GMT.*$/, "") + ": attic temp = " + atticTemp + 
            ", outside temp = " + outsideTemp + ", len=" + data.getTemperatureLength() + 
            ", data recorded = " + recordTemp);
                
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

