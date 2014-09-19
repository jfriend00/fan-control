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
    "minToMs": parseNumber
};

function parseNumber(tempStr, args) {
    try {
        var temp, convert = args.type;
        tempStr = tempStr.trim();
        if (typeof tempStr !== "string" || !simpleNumberRegex.test(tempStr)) {
            return null;
        }
        temp = parseFloat(tempStr);
        if (isNaN(temp)) {
            return null;
        }
        
        // now do any range checking
        if ("preRangeLow" in args) {
            if (temp < args.preRangeLow) {
                return null;
            }
        }
        if ("preRangeHigh" in args) {
            if (temp > args.preRangeHigh) {
                return null;
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
        
        // now do any range checking
        if ("rangeLow" in args) {
            if (temp < args.rangeLow) {
                return null;
            }
        }
        if ("rangeHigh" in args) {
            if (temp > args.rangeHigh) {
                return null;
            }
        }
        return temp;
    } catch(e) {
        console.log("Exception thrown when parsing number string: '" + tempStr + "' ", e);
        return null;
    }
}

// dataObj is like this: {minTemp: "89.3"}
// formatObj is like this: {minTemp: "FtoC"}
// formatObj is like this: {minTemp: {type: "FtoC", rangeLow: 0, rangeHigh: 100}}

function parseDataObject(dataObj, formatObj) {
    var output = {}, key, convertType, args, dataStr, result, fn;
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
            result = fn(dataStr, args);
            if (result !== null) {
                output[key] = result;
            }
        }
    }
    return output;
}


module.exports = {
    parseNumber: parseNumber,
    parseDataObject: parseDataObject
};