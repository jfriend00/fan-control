// object to provide a moving average over a certain time (all points equally weighted within that time)
function timeAverager(deltaT) {
    this.deltaT = deltaT;
    this.data = [];
}

timeAverager.prototype = {
    add: function(value) {
        this.data.push({t: Date.now(), value: value});
        
        // FIXME: remove this debugging code
        // this logs if the difference between any two temperature points is more than 0.5 degrees
        // we're trying to see if the outside temperature is noisy
        function toFahrenheit(c) {
            return (+c * 9 / 5) + 32;
        }
        
        if (this.data.length > 1) {
            if (Math.abs(value - this.data[this.data.length - 2].value) > 0.5) {
                console.log("temperature jump from " + toFahrenheit(this.data[this.data.length - 2].value) + " to " + toFahrenheit(value));
            }
        }
        
        this.ageData();
        return this.getAverage();
    },

    getAverage: function() {
        // cycle through the array backwards
        var total = 0, cnt = 0, data = this.data, len = data.length;
        
        if (!len) return null;
        
        var baseT = data[len - 1].t;
        for (var i = len - 1; i >= 0; i--) {
            if (baseT - data[i].t <= this.deltaT) {
                total += data[i].value;
                ++cnt;
            } else {
                // assumes points are stored in time order
                break;
            }
        }
        if (cnt === 0) {
            return null;
        }
        return total / cnt;
    },
    
    ageData: function() {
        var now = Date.now();
        var data = this.data;
        
        // pull off the first item in the array as long as it's too old
        while (data.length && now - data[0].t > this.deltaT) {
            data.shift();
        }
        
    },
    
    setDeltaT: function(deltaT) {
        this.deltaT = deltaT;
    }
};

module.exports = {
    timeAverager: timeAverager
};