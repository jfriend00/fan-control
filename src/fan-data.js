"use strict";
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));

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
    config: {
        temperatureRetentionMaxItems: 5000,     // set from config with data.init()
    },
    
    
    // sync argument should only be used in shut-down situation
    // temperatures data format
    // time, atticTemp, outsideTemp
    // nnnnn, t1, t2
    writeData: function(filename, sync) {
        // let everyone read the file
        var filePermissions = 438;
        var fileMode = {mode: filePermissions, encoding: 'utf8'};
        var self = this;
        
        sync = sync || false;
        
        try {
            var saveData = {};
            saveData.fanOnOffEvents = data.fanOnOffEvents;
            saveData.temperatures = data.temperatures;
            var theData = JSON.stringify(saveData);
            if (sync) {
                // note: 438 decimal mode is to give everyone read and write privileges
                fs.writeFileSync(filename, theData, fileMode);
            } else {
                // note: when this file is created, it must be given rw rights to everyone
                // so that it can be written to upon SIGINT to save our data on shut-down
                // presumably, the process isn't running at normal privileges upon shutdown
                fs.writeFile(filename, JSON.stringify(saveData), fileMode, function(err) {
                    // FIXME: this exception won't get caught locally
                    if (err) throw err;
                });
            }
        } catch(e) {
            console.log(e, "data.writeData() - error writing data");
        }
        
        // can't write data out while it's already blocked for any reason
        if (self.dataBlock) {
            console.log("hit data block");
            return;
        }
        
        // TODO - with async writes here, it is possible for the next manipulation of the
        // temperature array to happen while we are in the middle of writing it to disk
        // Need to figure out what to do about that
        
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
                data.push(item.t + ", " + item.atticTemp + ", " + item.outsideTemp + "\r\n");
            }
            return fs.writeAsyncCheck(fd, data.join(""));
        }

        function writeFanOnOffRowsAsync(fd, index, num) {
            var data = [], item, limit = Math.min(index + num, self.fanOnOffEvents.length);
            for (var i = index; i < limit; i++) {
                item = self.fanOnOffEvents[i];
                data.push(item.t + ", " + item.event + "\r\n");
            }
            return fs.writeAsyncCheck(fd, data.join(""));
        }

        // todo: write to a temp filename and then do renames at end
        var fd, item, err = false;
        filename = filename.replace(".txt", "-new.txt");
        var tempHeader = '[temperatures] {"formatVersion": "1", "fields": ["t", "atticTemp", "outsideTemp"]}\r\n';
        var fanHeader = '[fanOnOff] {"formatVersion": "1", "fields": ["t", "event"]}\r\n';
        
        if (sync) {
            // synchronous saving, called upon process exit only
            try {
                self.dataBlock = true;
                fd = fs.openSync(filename, "w", 438);
                fs.writeSyncCheck(fd, tempHeader);
                for (var i = 0; i < self.temperatures.length; i++) {
                    item = self.temperatures[i];
                    fs.writeSyncCheck(fd, new Buffer(item.t + ", " + item.atticTemp + ", " + item.outsideTemp + "\r\n"));
                }
                // now write on/off data here
                fs.writeSyncCheck(fd, fanHeader);
                for (var i = 0; i < self.fanOnOffEvents.length; i++) {
                    item = self.fanOnOffEvents[i];
                    fs.writeSyncCheck(fd, new Buffer(item.t + ", " + item.event + "\r\n"));
                }
            } catch(e) {
                err = true;
                console.log(e, "Error writing data - sync");
            } finally {
                fs.closeSync(fd);
                // if err while writing, clean up the file
                if (err) {
                    fs.unlinkSync(filename);
                }
                self.dataBlock = false;
            }
        } else {
            // asynchronous saving
            console.log("setting dataBlock");
            self.dataBlock = true;
            var start = Date.now();
            console.log("async write started");
            fs.openAsync(filename, "w", 438).then(function(ffd) {
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
                return fs.closeAsync(fd);
            }).then(function() {
                fd = null;
                console.log("async write finished - elapsed = " + ((Date.now() - start) / 1000));
            }).catch(function(e) {
                if (fd) fs.closeAsync(fd);
                console.log(e, "data.writeData() - error writing data (new format)");
            }).finally(function() {
                console.log("clearing dataBlock");
                self.dataBlock = false;
            });
        }
    },
    
    // this is only synchronous - only used at startup
    readData: function(filename) {
        try {
            var theData = JSON.parse(fs.readFileSync(filename, 'utf8'));
            // sanity check to see that the saved data is there
            if (theData.fanOnOffEvents && theData.temperatures) {
                data.fanOnOffEvents = theData.fanOnOffEvents;
                data.temperatures = theData.temperatures;
            }
        } catch(e) {
            if (e.code !== 'ENOENT') {
                console.log("data.readData() - error reading data");
            }
        }
    },
    
    ageData: function() {
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
        truncateToNumberOfDays(temps, this.config.temperatureRetentionDays);
        truncateToNumberOfDays(this.fanOnOffEvents, this.config.fanEventRetentionDays);
    },
    
    // time is optional - if not passed, the current time will be used
    addTemperature: function(tAttic, tOutside, time) {
        time = time || Date.now();
        this.temperatures.push({t: time, atticTemp: tAttic, outsideTemp: tOutside});
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
        // FIXME: writeTime defaulted to short time for debugging purposes
        this.config.writeTime = config.writeTime || 15 * 1000;
        this.config.temperatureRetentionMaxItems = config.temperatureRetentionMaxItems;
        this.config.temperatureRetentionDays = config.temperatureRetentionDays;
        this.config.fanEventRetentionDays = config.fanEventRetentionDays;
        this.config.filename = config.filename;
        // read any prior data
        this.readData(this.config.filename);
        
        var self = this;
        // save the data on a recurring timer
        this.dataWriteInterval = setInterval(function() {
            data.writeData(self.config.filename, false);
        }, this.config.writeTime);
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

