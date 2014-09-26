// data validation functions

var simpleNumberRegex = /^[-+]?\d*(\.\d*)?$/;

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


var convertTypeMap = {
    "decimal": parseNumber,
    "FtoC": parseNumber,
    "CtoF": parseNumber,
    "FDeltaToC": parseNumber,
    "CDeltaToF": parseNumber,
    "minToMs": parseNumber,
    "duration": parseNumber,
};

function parseNumber(tempStr, args) {

    // pass something like "preRange", "Low"
    // will look first for "preRangeLowMsg", then for "preRangeAllMsg"
    function getMsg(base, suffix, defaultMsg) {
        var result = {val: null};
        result.err = args[base + suffix + "Msg"];
        if (result.err) { return result; }
        result.err = args[base + "AllMsg"];
        if (result.err) { return result; }
        if (defaultMsg) {
            result.err = defaultMsg;
        } else {
            result.err = "Unable to parse number";
        }        
        return result;
    }

    var result = {val: null};
    try {
        var temp, convert = args.type;
        tempStr = tempStr.trim();
        if (typeof tempStr !== "string") {
            result.err = "data not a string";
            return result;
        }
        if (!simpleNumberRegex.test(tempStr)) {
            result.err = "contains non-numeric characters";
            return result;
        }
        try {
            temp = parseFloat(tempStr);
            if (isNaN(temp)) {
                result.err = "invalid number";
                return result;
            }
        } catch(e) {
            result.err = "parsing number failed";
            return result;
        }
        
        // now do any range checking
        if ("preRangeLow" in args) {
            if (temp < args.preRangeLow) {
                return getMsg("preRange", "Low", "value too low");
            }
        }
        if ("preRangeHigh" in args) {
            if (temp > args.preRangeHigh) {
                return getMsg("preRange", "High", "value too high");
            }
        }
        
        if (convert === "FtoC") {
            temp = toCelsius(temp);
        } else if (convert === "CtoF") {
            temp = toFahrenheit(temp);
        } else if (convert === "FDeltaToC") {
            temp = toCelsiusDelta(temp);
        } else if (convert === "CDeltaToF") {
            temp = toFahrenheitDelta(temp);
        } else if (convert === "minToMs") {
            temp = Math.round(temp * 1000 * 60);
        }
        
        if (convert === "duration" && args.units) {
            switch(args.units) {
                case "minutes":
                    temp = Math.round(temp * 1000 * 60);
                    break;
                case "hours":
                    temp *= 1000 * 60 * 60;
                    break;
                case "days":
                    temp *= 1000 * 60 * 60 * 24;
                    break;
            }
        }
        
        // now do any range checking
        if ("rangeLow" in args) {
            if (temp < args.rangeLow) {
                return getMsg("range", "Low", "value too low");
            }
        }
        if ("rangeHigh" in args) {
            if (temp > args.rangeHigh) {
                return getMsg("range", "High", "value too high");
            }
        }
        result.val = temp;
        return result;
    } catch(e) {
        console.log("Exception thrown when parsing number string: '" + tempStr + "' ", e);
        result.err = "can't parse number";
        result.val = null;
        return result;
    }
}

// dataObj is like this: {minTemp: "89.3"}
// formatObj is like this: {minTemp: "FtoC"}
// formatObj is like this: {minTemp: {type: "FtoC", rangeLow: 0, rangeHigh: 100, rangeAllMsg: "some text here", rangeLowMsg: "some text here", rangeHighMsg: "some text here"}}

// returns an object with one or two properties
// if the err property exists, then there was some sort of parsing error

function parseDataObject(dataObj, formatObj) {
    var output = {}, err = {}, key, convertType, args, dataStr, result, fn, hadErr = false;
    for (key in formatObj) {
        args = formatObj[key];
        // shortcut to allow su to pass just a string
        if (typeof args === "string") {
            args = {type: args};
        }
        convertType = args.type;
        dataStr = dataObj[key];
        fn = convertTypeMap[convertType];
        // if not in convertTypeMap, drop it from the output
        if (fn) {
            // if we have a units specified as another object, then fetch that value
            if (args.units && dataObj[args.units]) {
                args.units = dataObj[args.units];
            }
            result = fn(dataStr, args);
            if (result.val !== null) {
                output[key] = result.val;
            } else {
                hadErr = true;
                err[key] = result.err;
            }
        }
    }
    if (hadErr) {
        return {output: output, err: err};
    } else {
        return {output: output};
    }
}


module.exports = {
    parseNumber: parseNumber,
    parseDataObject: parseDataObject
};