

interface IPossibleValues
{
    values : string[];
    valuesWithFrqeuency : string[];
}

// https://stackoverflow.com/questions/3579486/sort-a-javascript-array-by-frequency-and-then-filter-repeats
// Return array with duplicates removed and sorted by frequency. 
function sortByFrequency(array : string[]) : string[]{
    var frequency : any= {};

    array.forEach(function(value) { frequency[value] = 0; });

    var uniques = array.filter(function(value) {
        return ++frequency[value] == 1;
    });

    var x = uniques.sort(function(a, b) {
        return frequency[b] - frequency[a];
    });

    // append frequency 
    for(var i in x) {
        var val = x[i];
        var freq = frequency[val];
        x[i] = val +" (x" + freq +")";
    }
    return x;
}

// Represents statistics about a column. 
// Analyze column contents to infer statistics and type.
export class ColumnStats {
    private _uniques: Array<string>; // array of unique values in this column 
    private _possibleValues: Array<string>; // non-blank unique values in this column. 
    private _numBlanks : number = 0;  // number of blank elements in this column. 
    private _isTagType : boolean; // true if this column is a tag. 

    private _isDate : boolean;

    private _isNumber : boolean; 
    private _numberMin : number;
    private _numberMax : number;

    
    public isTagType() : boolean { return this._isTagType };
    public isNumberType() : boolean { return this._isNumber; };

    public hasBlanks() : boolean { return this._numBlanks > 0; }

    // Only valid if IsNumberType
    public getNumberRange() : number[] { return [ this._numberMin, this._numberMax]; };
    public getPossibleValues() : string[] { return this._possibleValues; }
    

    public constructor(vals: string[]) {
        
        var nonBlank : string[] = []

        this._possibleValues = []; // empty 

        // Really should get this from metadata instead. 
        var isTagType = true; // Tag is either Blank or '1'
        this._isNumber = true;
        
        for(var i in vals)
        {
            var val = vals[i];
            if (!val || val.length == 0) {
                this._numBlanks++;
            } else {
                this._possibleValues.push(val);
                if (val != "1" && val != "0")
                {
                    isTagType = false;
                }

                // Check int? 
                if (!isNaN(<any> val))
                {
                    var num = parseFloat(val);
                    if (this._numberMin) {
                        if (num < this._numberMin) {
                            this._numberMin = num;
                        }
                    } else {
                        this._numberMin = num;
                    }
                    if (this._numberMax) {
                        if (num > this._numberMax) {
                            this._numberMax  = num;
                        }
                    } else {
                        this._numberMax = num;
                    }
                } else {
                    this._isNumber = false;
                }

                nonBlank.push(val);
            }
        }
        if (this._numBlanks == 0 || this._numBlanks == vals.length)
        {
            isTagType = false; // Must have at least one occurence of the tag .
        }
        this._isTagType = isTagType;

        if (this._isTagType || !this._numberMin) 
        {
            this._isNumber = false; // tag takes precedence 
        }

        this._uniques = sortByFrequency(nonBlank);
    }

    // Get a short summary string for the values in this column. 
    public getSummaryString(totalSize: number): string {
        var numBlank: number = this._numBlanks;

        if (this._isTagType) {
            var no = this._numBlanks; // items without tag 
            var yes = totalSize - no; // items with tag

            var yesPercent = Math.floor(yes * 1000 / totalSize) / 10; // 1 decimal place
            return "(tag) " + yes + " (" + yesPercent + "%) rows tagged"; 
            
        }

        if (numBlank == totalSize) {
            return "(empty)";
        }
        if (this._uniques.length == totalSize) {
            // This is very likely a primary key
            return "(all unique)";
        }

        var text = "";
        var threshold = 8; // Only display discrete values for small numbers
        if (this._uniques.length > threshold) {
            if (this._isNumber) {
                return "Number in range (" + this._numberMin + "," + this._numberMax + ")";
            }
            else 
            {
                text = this._uniques.length + " total unique values";
            }
        } else {
            // values are already sorted by frequency. 
            text = this._uniques.join();
        }

        if (numBlank > 0) {
            text += " (" + numBlank + " blank)";
        } else if (numBlank == 0 && this._uniques.length == 1) {
            // This is the same value for every row in the cell
            text += " (constant)";
        }

        return text;
    }
}
