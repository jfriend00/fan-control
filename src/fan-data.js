"use strict";
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var lineReader = require('./line-reader.js');

initFS();

// system initialization boots up with the fan off so that is always the initial state
// lastFanChangeTime is initialized to zero so there are no limitations on turning the fan on initially
// fanOnOffEvents and temperatures are stored on disk and reread from disk at boot up
var data = {
    fanOnOffEvents: [],     // array of {t: dateTime, event: "on" or "off"}
    fanOn: false,           // current fan state
    temperatures: [],       // array of {t: dateTime, atticTemp: temp, outsideTemp: temp}
    lastFanChangeTime: 0,   // last time we changed the fan setting
    lastDataWriteTime: 0,   // last time data was saved to SD card
    dataBlock: false,       // true means we're doing an async save of the data so no modifications
    queue: [],              // queued up function calls when dataBlock prevented direct addition
    config: {
        temperatureRetentionMaxItems: 5000,     // set from config with data.init()
    },
    
    
    // sync argument should only be used in shut-down situation
    // temperatures data format
    // time, atticTemp, outsideTemp
    // nnnnn, t1, t2
    
    getDataBlock: function() {
        return this.dataBlock;
    },
    
    writeData: function(filename, sync) {
        // let everyone read the file
        var filePermissions = 438;
        var self = this;
        sync = sync || false;

        // can't write data out while it's already blocked for any reason
        // FIXME: problem - what happens if we hit the dataBlock upon exit
        if (self.dataBlock) {
            console.log("hit data block");
            return;
        }
        
        // write new data format
        // each section starts with [title]
        // The title is followed by a JSON description of the format
        // Then, you have comma delimited rows of data, one row per line
        // [temperatures] {"formatVersion": "1", "fields": ["t", "atticTemp", "outsideTemp"]}
        // 927349724972, 29.8, 23.6
        // 927349725190, 29.9, 23.5
        
        function writeTemperatureRowsAsync(fd, index, num) {
            var data = [], item, limit = Math.min(index + num, self.temperatures.length);
            for (var i = index; i < limit; i++) {
                item = self.temperatures[i];
                data.push(item.t + "," + item.atticTemp + "," + item.outsideTemp + "\r\n");
            }
            return fs.writeAsyncCheck(fd, data.join(""));
        }

        function writeFanOnOffRowsAsync(fd, index, num) {
            var data = [], item, limit = Math.min(index + num, self.fanOnOffEvents.length);
            for (var i = index; i < limit; i++) {
                item = self.fanOnOffEvents[i];
                data.push(item.t + "," + item.event + "," + item.reason.replace(",", "-") + "\r\n");
            }
            return fs.writeAsyncCheck(fd, data.join(""));
        }

        var fd, item, i;
        var tempHeader = '[temperatures] {"formatVersion": "1", "fields": ["t", "atticTemp", "outsideTemp"]}\r\n';
        var fanHeader = '[fanOnOff] {"formatVersion": "1", "fields": ["t", "event", "reason"]}\r\n';
        var tempFilename = filename.replace(/txt$/, "tmp");        
        
        if (sync) {
            // synchronous saving, called upon process exit only
            try {
                self.dataBlock = true;
                fd = fs.openSync(tempFilename, "w", filePermissions);
                fs.writeSyncCheck(fd, tempHeader);
                for (i = 0; i < self.temperatures.length; i++) {
                    item = self.temperatures[i];
                    fs.writeSyncCheck(fd, new Buffer(item.t + "," + item.atticTemp + "," + item.outsideTemp + "\r\n"));
                }
                // now write on/off data here
                fs.writeSyncCheck(fd, fanHeader);
                for (i = 0; i < self.fanOnOffEvents.length; i++) {
                    item = self.fanOnOffEvents[i];
                    fs.writeSyncCheck(fd, new Buffer(item.t + "," + item.event + "," + item.reason.replace(",", "-") + "\r\n"));
                }
                fs.closeSync(fd);
                fd = null;
                // now do rename of the temp file
                try {
                    fs.unlinkSync(filename);
                } catch(e) {
                    // if it failed for any reason other than because it didn't exist
                    // then rethrow the error so it gets reported in the logs
                    if (e.code !== "ENOENT") {
                        throw e;
                    }
                }
                fs.renameSync(tempFilename, filename);
            } catch(e) {
                console.log(e, "Error writing data - sync");
            } finally {
                // if file wasn't yet closed, then it's a partial file
                // so we have to close it and get rid of it
                if (fd) {
                    try {
                        fs.closeSync(fd);
                        fs.unlinkSync(tempFilename);
                    } catch(e) {
                        console.log(e, "Error cleaning up on writeData");
                    }
                }
                self.dataBlock = false;
            }
        } else {
            // asynchronous saving
            self.dataBlock = true;
            var start = Date.now();
            fs.openAsync(tempFilename, "w", filePermissions).then(function(ffd) {
                fd = ffd;
                // write temperature data header
                return fs.writeAsyncCheck(fd, tempHeader);
            }).then(function() {
                // write temperature data
                // algorithm, return an unresolved promise that will be resolved
                // only when we're done writing out all our data
                return new Promise(function(resolve, reject) {
                    var rowsToWriteAtOnce = 100;
                    // now write out all the data
                    var index = 0;
                    
                    function next() {
                        if (index < self.temperatures.length) {
                            writeTemperatureRowsAsync(fd, index, rowsToWriteAtOnce).then(function(args /* [written, buffer] */) {
                                index += rowsToWriteAtOnce;
                                next();
                            }).catch(function() {
                                reject("write error");
                            });
                        } else {
                            resolve();
                        }
                    }
                    next();
                });
            }).then(function() {
                // write fan header
                return fs.writeAsyncCheck(fd, fanHeader);
            }).then(function() {
                // write fan data
                // algorithm, return an unresolved promise that will be resolved
                // only when we're done writing out all our data
                return new Promise(function(resolve, reject) {
                    var rowsToWriteAtOnce = 100;
                    // now write out all the data
                    var index = 0;
                    
                    function next() {
                        if (index < self.fanOnOffEvents.length) {
                            writeFanOnOffRowsAsync(fd, index, rowsToWriteAtOnce).then(function(args /* [written, buffer] */) {
                                index += rowsToWriteAtOnce;
                                next();
                            }).catch(function() {
                                reject("write error");
                            });
                        } else {
                            resolve();
                        }
                    }
                    next();
                });
            }).then(function() {
                return fs.closeAsync(fd);
            }).then(function() {
                fd = null;
                // rename files
                return new Promise(function(resolve, reject) {
                    fs.unlinkAsync(filename).catch(function(e) {
                        if (e.code !== "ENOENT") {
                            console.log(e, "Error removing old data file on writeData Async");
                        }
                    }).finally(function() {
                        fs.renameAsync(tempFilename, filename).catch(function(e) {
                            console.log(e, "Error on rename in writeData Async");
                        }).finally(resolve);
                    });
                });                
            }).catch(function(e) {
                // if we got an error here, then close the file and remove it
                console.log(e, "data.writeData() - error writing data (new format)");
                fs.closeAsync(fd).then(function() {
                    return fs.unlinkAsync(tempFilename);
                }).catch(function() {
                    console.log("Error cleaning up on .catch() from writeData");
                });
            }).finally(function() {
                self.dataBlock = false;
                
                // process any events that were blocked while we were writing the data
                self.processQueue();
            });
        }
    },
    
    readData: function(filename) {
        // read in the new format:
        var self = this;
        try {
            var sectionStart = /^\[(.*?)\]\s+(\{.*\})/;
            var matches, line, fn;
            
            var processors = {
                temperatures: function(line) {
                    // 1409778007274, 25.5, 24.9
                    var valid = false;
                    var items = line.split(",");
                    if (items.length >= 3) {
                        // convert all values to numbers
                        var t = parseInt(items[0].trim(), 10);
                        var tAttic = +items[1].trim();
                        var tOutside = +items[2].trim();
                        if (t && tAttic && tOutside) {
                            valid = true;
                            self.addTemperature(tAttic, tOutside, t);
                        }
                    if (!valid)
                        console.log("Unexpected or missing data while processing temperature line: " + line);
                    }
                },
                fanOnOff: function(line) {
                    // 1409778007274, on, reason
                    var valid = false;
                    var items = line.split(",");
                    if (items.length >= 2) {
                        var t = parseInt(items[0].trim(), 10);
                        var event = items[1].toLowerCase();
                        var reason = items[2] || "";
                        if (t && (event === "on" || event === "off")) {
                            valid = true;
                            self.addFanOnOffEvent(event, reason, t);
                        }
                    }
                    if (!valid) {
                        console.log("Unexpected or missing data while processing fan event line: " + line);
                    }
                },
                dummy: function() {}
            };
            
            var lr = new lineReader(filename);
            while ((line = lr.readLineSync()) !== null) {
                matches = line.match(sectionStart);
                if (!matches) {
                    if (fn) {
                        // ignore empty lines
                        if (line.trim()) {
                            fn(line);
                        }
                    } else {
                        throw new Error("Expected section start in readData");
                    }
                } else {
                    // section start
                    fn = processors[matches[1]];  
                    if (!fn) {
                        console.log("Unknown section: " + matches[1] + " - skipping section");
                        fn = processors.dummy;
                    }
                }
            }
        } catch(e) {
            if (e.code !== "ENOENT") {
                console.log(e, "lineReader error");
            }
        }
    },
    
    // process any functions in the queue
    // if data isn't blocked
    processQueue: function() {
        if (!this.dataBlock && this.queue.length) {
            console.log("running queued functions");
            // this assumes all queued operations are synchronous
            // thus we don't have to check for dataBlock after each one
            // it will tolerate new queued functions being added while running others
            for (var i = 0; i < this.queue.length; i++) {
                this.queue[i]();
            }
            // clear the queue
            this.queue.length = 0;
        }
    },
    
    ageData: function() {
    
        function run() {
             /*jshint validthis:true */
             
            // see if there are just too many temperatures retained
            // this is to protect memory usage in case temperature varies wildly
            // so we are recording too many data points
            // oldest items are at the beginning of the array so remove from the beginning
            var temps = this.temperatures;
            var numToRemove = temps.length - this.config.temperatureRetentionMaxItems;
            if (numToRemove > 0) {
                // this avoids making a copy of the data (good for memory usage reasons)
                if (numToRemove === 1) {
                    // .shift() is 3x faster than .splice() and is the common use case
                    temps.shift();
                } else {
                    temps.splice(0, numToRemove);
                }
            }

            // assumes each array element is an object with a .t property
            // FIXME: this needs to process the array from backwards to frontwards
            function truncateToNumberOfDays(array, n) {
                // keep track of each unique day of data we encounter
                var days = [];
                for (var i = 0, len = array.length; i < len; i++) {
                    var day = getDayT(array[i].t);
                    // if day is not already in our array and we've reach the max number of days
                    // allow one extra day for the unfinished day today so we always have
                    // n of full older days
                    if (days.indexOf(day) === -1) { 
                        if (days.length > n) {
                            // then truncate the array and be done
                            array.length = i;
                            return;
                        } else {
                            days.push(day);
                        }
                    }
                }
            
            }

            // truncate arrays to max number of days of data
            // truncateToNumberOfDays(temps, this.config.temperatureRetentionDays);
            // truncateToNumberOfDays(this.fanOnOffEvents, this.config.fanEventRetentionDays);
        }
        
        if (this.dataBlock) {
            console.log("hit dataBlock on ageData() - queueing");
            this.queue.push(run.bind(this));
        } else {
            run.call(this);
        }
    },

/*     
    // generic queue method support
    addQueueSupport: function(methods) {
        for (var i = 0; i < methods.length; i++) {
            (function(name) {
                var oldMethod = this[name];
                this[name] = function() {
                    if (this.dataBlock) {
                        var args = Array.prototype.slice.call(arguments);
                        this.queue.push(oldMethod.bind.apply(this, args);
                    } else {
                        oldMethod.apply(this, arguments);
                    }
                };
            }).call(this, methods[i]);
        }
    },
*/    
    
    // time is optional - if not passed, the current time will be used
    addTemperature: function(tAttic, tOutside, time) {
        var self = this;
        time = time || Date.now();
        
        function add() {
            self.temperatures.push({t: time, atticTemp: tAttic, outsideTemp: tOutside});
        }
        
        if (this.dataBlock) {
            console.log("hit dataBlock on addTemperature() - queueing");
            this.queue.push(add);
        } else {
            add();
        }
    },
    
    addFanOnOffEvent: function(event, reason, time) {
        var self = this;
        time = time || Date.now();
        
        function add() {
            self.fanOnOffEvents.push({t: time, reason: reason, event: event});
        }
        
        if (this.dataBlock) {
            console.log("hit dataBlock on addFanOnOffEvent() - queueing");
            this.queue.push(add);
        } else {
            add();
        }
    },
    
    // negative numbers are from end (so -1 gives last item)
    getTemperatureItem: function(index) {
        var len = this.temperatures.length;
        if (len) {
            if (index < 0) {
                index = len + index;
            }
            if (index >= 0 && index < len) {
                return this.temperatures[index];
            }
        }
        return null;
    },
    
    getTemperatureLength: function() {
        return this.temperatures.length;
    },
    
    // iterate temperatures with callback
    // assumes temperature array is not modified during iteration other than adding onto the end
    eachTemperature: function(fn) {
        var retVal;
        for (var i = 0, len = this.temperatures.length; i < len; i++) {
            retVal = fn(this.temperatures[i]);
            if (retVal === true) {
                return;
            }
        }
    },
    
    // iterate on/off events
    eachEvent: function(fn) {
        var retVal;
        for (var i = 0, len = this.fanOnOffEvents.length; i < len; i++) {
            retVal = fn(this.fanOnOffEvents[i]);
            if (retVal === true) {
                return;
            }
        }
    },
    
    getFanOnOffDataSmallJSON: function() {
        // make on/off data in an efficient form as an array of these [t, "on"]
        var onOff = [];
        data.eachEvent(function(item) {
            onOff.push([item.t, item.event, item.reason || ""]);
        });
        return JSON.stringify(onOff);
    },
    
    getTemperatureDataSmallJSON: function() {
        // build client-side data structure as an array of these [time, t1, t2]
        var temps = [];
        data.eachTemperature(function(item) {
            temps.push([item.t, item.atticTemp, item.outsideTemp]);
        });
        return JSON.stringify(temps);
    },
    
    /* This is a sample iteration of temperature data 
    var item;
    for (var i = 0, len = data.getTemperatureLength(), i < len; i++) {
        item = data.getTemperatureItem(i);
    }
    
    // or this
    data.eachTemperature(function(item) {
        // do something with item here
    });
    */
    
    init: function(config) {
        this.config.writeTime = config.writeTime || (60 * 60 * 1000);
        this.config.temperatureRetentionMaxItems = config.temperatureRetentionMaxItems;
        this.config.temperatureRetentionDays = config.temperatureRetentionDays;
        this.config.fanEventRetentionDays = config.fanEventRetentionDays;
        this.config.filename = config.filename;
        this.config.highLowFilename = config.highLowFilename;
        // read any prior data
        this.readData(this.config.filename);
        
        var self = this;
        // save the data on a recurring timer
        this.dataWriteInterval = setInterval(function() {
            data.writeData(self.config.filename, false);
        }, this.config.writeTime);
        
        this.logger = new HighLowLogger(this.config.highLowFilename);
    }
};



module.exports = data;

function initFS() {
    // wrapper function to allow optional args
    // and to check if all bytes were written
    fs.writeAsyncCheck = function(fd, data, offset, len, position) {
        // allow position, len and offset arguments to be optional
        if (position === undefined) {
            position = null;
            if (len === undefined) {
                len = data.length;
                if (offset === undefined) {
                    offset = 0;
                }
            }
        }
        var str = data;
        if (!(data instanceof Buffer)) {
            data = new Buffer(data);
        }
        return new Promise(function(resolve, reject) {
            // .spread is like .then, but multiple arguments are sent as separate args
            // rather than in an array
            fs.writeAsync(fd, data, offset, len, position).spread(function(written, buffer) {
                if (written !== len) {
                    reject(new Error("expected to write " + len + " bytes, but only wrote " + written + " bytes."));
                } else {
                    resolve(written);
                }
            }).catch(function(e) {
                console.log(e, "fs.writeAsync threw");
                console.log('"' + str + '"');
                reject(e);
            });
        });
    };
    
    fs.writeSyncCheck = function(fd, data, offset, len, position) {
        // allow position, len and offset arguments to be optional
        if (position === undefined) {
            position = null;
            if (len === undefined) {
                len = data.length;
                if (offset === undefined) {
                    offset = 0;
                }
            }
        }
        if (!(data instanceof Buffer)) {
            data = new Buffer(data);
        }
        var written = fs.writeSync(fd, data, offset, len, position);
        if (written !== len) {
            throw new Error("expected to write " + len + " bytes, but only wrote " + written + " bytes.");
        }
        return written;
    };
}

// get the time in ms of the previous midnight (start of the day)
// for use in same day comparisons
function getDayT(t) {
    var date = new Date(t);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

// high low file contains a series of lines of data like this:
// dayT,high,low
// 10-30-2014,23.2,18.7
// The file is assumed to be in order and with only one hi-lo entry for each day
// There can be missing days if not enough data was recorded for that day
// The date is mid-night at start of the day, temperatures are in Celsius


function HighLowLogger(fname) {
    this.fname = fname;
    this.lastDayBegin = 0;
    this.initialize();
}

HighLowLogger.prototype = {
    // open the file and read the last line to get the last date
    // this is done synchronously (only called at startup)
    initialize: function() {
        var fd, bufLen = 1024;
        try {
            fd = fs.openSync(this.fname, "r");
            var stats = fs.fstatSync(fd);
            var buffer = new Buffer(bufLen);
            // read last bytes of file
            var bytesRead = fs.readSync(fd, buffer, 0, buffer.length, stats.size - buffer.length);
            var data = buffer.slice(0, bytesRead).toString();
            var lines = data.split("\n");
            var lastLine = lines.pop().replace(/[\r\n]/g, "");
            if (!lastLine) {
                lastLine = lines.pop().replace(/[\r\n]/g, "");
            }
            // should have lastLine here
            var data = this.parseLine(lastLine);
            this.lastDayBegin = data.t;
        } catch(e) {
            if (e.code !== "ENOENT") {
                console.log("Error initializing HighLowLogger", e);
            }
        } finally {
            if (fd) {
                fs.closeSync(fd);
            }
        }
        
        // check to update this data every couple hours
        // though it will only have anything to do, the first time it's called after midnight
        this.interval = setInterval(this.logNewDays.bind(this), 1000 * 60 * 60 * 2);
    },
    
    // sample line
    // 10-30-2014,23.2,18.7
    parseLine: function(line) {
        var data = {};
        var items = line.split(",");
        if (items < 3) {
            return null;
        }
        var datePieces = items[0].split("-");
        if (datePieces < 3) {
            return null;
        }
        data.t = new Date(+datePieces[2], +datePieces[0] - 1, +datePieces[1]).getTime();
        data.high = +items[1];
        data.low = +items[2];
        return data;
    },
    
    checkForNewDays: function() {
        var dayMs = 1000 * 60 * 60 * 24;
        // a full day of data is considered to be within 30 mins of a full day
        // we assume that if it was running in the beginning and end, it was running the full day
        // this could be smarter, but probably doesn't need to be
        var minDay = dayMs - (1000 * 60 * 30);
        var newData = [], currentDayBegin, currentDayEnd, 
            highTemp = 0, lowTemp = 1000, firstTime, lastTime, haveData;
            
        function flush() {
            // only record full days
            if (haveData && (lastTime - firstTime >= minDay)) {
                newData.push({t: currentDayBegin, high: highTemp, low: lowTemp});
            }
        }
        
        function initDay(dayBegin) {
            currentDayBegin = dayBegin;
            currentDayEnd = dayBegin + dayMs;
            haveData = false;
        }
        
        // start looking for the next day after we already recorded
        initDay(this.lastDayBegin + dayMs);
        
        data.eachTemperature(function(item) {
            // only consider temperatures after lastDay
            if (item.t >= currentDayBegin) {
                if (item.t >= currentDayEnd) {
                    flush();
                    initDay(getDayT(item.t));
                }
                // it is in the current day we are collecting data for
                // if we don't have any data yet, then just initialize everything
                if (!haveData) {
                    highTemp = item.outsideTemp;
                    lowTemp = item.outsideTemp;
                    firstTime = item.t;
                    lastTime = item.t;
                    haveData = true;
                } else {
                    highTemp = Math.max(item.outsideTemp, highTemp);
                    lowTemp = Math.min(item.outsideTemp, lowTemp);
                    lastTime = item.t;
                }
            }
        });
        flush();
        return newData;
    },
    
    logNewDays: function(callback) {
        callback = callback || function() {};
        var newData = this.checkForNewDays();
        var data = "", item, self = this, dateStr, date;
        if (newData.length) {
            for (var i = 0; i < newData.length; i++) {
                item = newData[i];
                date = new Date(item.t);
                dateStr = (date.getMonth() + 1) + "-" + date.getDate() + "-" + date.getFullYear();
                data += dateStr + "," + item.high + "," + item.low + "\n";
            }
            console.log("new hi-lo data:\n", data);
            fs.appendFile(this.fname, data, function(err) {
                if (err) {
                    callback(err);
                } else {
                    // remember the last day we've written
                    self.lastDayBegin = newData[newData.length - 1].t;
                }
            });
            
        } else {
            process.nextTick(function() {
                // nothing to do so call the callback async with no error
                callback(0);
            });
        }
    }
};


