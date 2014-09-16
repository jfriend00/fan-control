"use strict";
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));

var rev = fs.readFileSync("/proc/cpuinfo").toString().split("\n").filter(function(line) {
	return line.indexOf("Revision") == 0;
})[0].split(":")[1].trim();

// mapping from Pi pin numbers to SOC GPIO numbers
var pinMapping = {
	"3": "0",
	"5": "1",
	"7": "4",
	"8": "14",
	"10": "15",
	"11": "17",
	"12": "18",
	"13": "21",
	"15": "22",
	"16": "23",
	"18": "24",
	"19": "10",
	"21": "9",
	"22": "25",
	"23": "11",
	"24": "8",
	"26": "7",

	// Model B+ pins
	"29": "5",
	"31": "6",
	"32": "12",
	"33": "13",
	"35": "19",
	"36": "16",
	"37": "26",
	"38": "20",
	"40": "21"
};

console.log("getgid(): ", process.getgid());

// adjust pins for rev 2 boards
if(rev == "2") {
	pinMapping["3"] = "2";
	pinMapping["5"] = "3";
	pinMapping["13"] = "27";
}

function checkPin(piPin) {
    piPin = piPin + "";
    var socPin = pinMapping[piPin];
    if (socPin === undefined) {
        throw new Error("invalid pin number " + piPin);
    }
    return socPin;
}

function checkDirection(direction) {
    direction = direction || "out";
    var valids = {in: "in", input: "in", out: "out", output: "out"};
    var dir = valids[direction];
    if (!dir) {
        throw new Error("invalid pin direction");
    }
    return dir;
}

var importExportBasePath = "/sys/class/gpio/";
var exportPath = importExportBasePath + "export";
var unexportPath = importExportBasePath + "unexport";
var pinBasePath = "/sys/devices/virtual/gpio/gpio";
var encoding = {encoding: 'utf-8'};

// valid type arguments are:
//    "direction"
//    "value"
//    "active_low"
//    "edge"
function allowAccess(chipPin, type) {
    // Unfortunately, this doesn't work without ROOT privileges
    
    var mode = 384;    // Decimal equivalent for 0600 octal for Linux permissions S_IRUSR | S_IWUSR
    var path = pinBasePath + chipPin + "/" + type;
    return fs.chownAsync(path, process.getuid(), process.getgid()).then(function() {
        return fs.chmodAsync(path, mode);
    });    
}

function allowAccessAll(pin) {
    var chipPin = checkPin(pin);
    var items = ["direction", "value", "active_low", "edge"];
    
    return items.reduce(function(p, current, index, array) {
        return p.then(function() {
            return allowAccess(chipPin, current);
        });
    }, Promise.resolve());
}

var gpio = {
    open: function(pin, direction) {
        var chipPin = checkPin(pin);
        
        // export the pin
        return fs.writeFileAsync(exportPath, chipPin, null).then(function() {
            return allowAccessAll(pin).then(function() {
                gpio.setDirection(pin, direction);
            });
        }).catch(function(err) {
            if (err.cause.code === "EBUSY") {
                // ignore the EBUSY code because it may very well be that it is already exported
                // if this is not the case, then the setDirection below will fail anyway
                console.log("Warning: EBUSY when exporting GPIO pin - might be already exported");
                return gpio.setDirection(pin, direction);
            } else {
                // rethrow err as this is not an error we think we can ignore
                throw err;
            }
        });
    },
    close: function(pin) {
        var chipPin = checkPin(pin);
        return fs.writeFileAsync(unexportPath, chipPin, null);
    },
    setDirection: function(pin, direction) {
        var chipPin = checkPin(pin);
        direction = checkDirection(direction);
        return fs.writeFileAsync(pinBasePath + chipPin + "/direction", direction, null);
    },
    closeSync: function(pin) {
        var chipPin = checkPin(pin);
        return fs.writeFileSync(unexportPath, chipPin, null);
    }
}

module.exports = gpio;
