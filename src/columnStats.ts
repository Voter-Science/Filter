

interface IPossibleValues {
    values: string[];
    valuesWithFrqeuency: string[];
}

// https://stackoverflow.com/questions/3579486/sort-a-javascript-array-by-frequency-and-then-filter-repeats
// Return array with duplicates removed and sorted by frequency. 
function sortByFrequency(array: string[]): string[] {
    var frequency: any = {};

    array.forEach(function (value) { frequency[value] = 0; });

    var uniques = array.filter(function (value) {
        return ++frequency[value] == 1;
    });

    var x = uniques.sort(function (a, b) {
        return frequency[b] - frequency[a];
    });

    // append frequency 
    for (var i in x) {
        var val = x[i];
        var freq = frequency[val];
        x[i] = val + " (x" + freq + ")";
    }
    return x;
}

interface IGrouper 
{
    getGroupByValues() : string [];
    getGroupByIndex(val : string) : number;
    getColors() : string[];
}

// Percentage from 0...100%. Group in 5 buckets 
class PercentageGrouper implements IGrouper 
{
    private static _result : string[] = [
        "(Blank)", "0-20%", "20-40%", "40-60%", "60-80%", "80-100%"];

    public getGroupByValues() : string []
    {
        return PercentageGrouper._result;
    }

    // undefined if not mapped
    public getGroupByIndex(val : string) : number
    {        
        var x = parseFloat(val);
        if (isNaN(x)) {
            return 0;
        }
        if (val[val.length-1] != '%') {
            x  = x * 100.0;
        }

        var max = PercentageGrouper._result.length - 1; // ignore (blank)
        x /= (100 / max);
        x = Math.floor(x)
        if (x < 0) { x = 0; }
        if (x >= max) { x = max-1 };
        
        return x + 1; // adjust for (blank)
    }
    public getColors() : string[]{
        return null;
    }
}


class TagGrouper implements IGrouper 
{
    private static _result : string[] = ["Yes", "No"];

    public getGroupByValues() : string []
    {
        return TagGrouper._result;
    }

    // undefined if not mapped
    public getGroupByIndex(val : string) : number
    {
        if (val == '1') {
            return 0; // idx of YES
        }
        return 1; // idx of No
    }

    public getColors() : string[] {
        return [ "#00CC00", "#CC0000"]; // Green for yes, Red for no.
    }
}

class GenericGrouper implements IGrouper 
{
    private _valueIdx : any = { }; // value --> idx into counts

    private _possibleValues: Array<string>;
    public _colors : string[] ;

    // // non-blank, unique values, alphabetically sorted 
    public constructor(values: Array<string>, includeBlank : boolean) 
    {
        this._colors = null;
        values = values.slice(0);
        var valueIdx : any = { }; // value --> idx into counts
        
        // Build up index 
        for(var i  =0; i < values.length; i++) {
            var x = values[i];
            valueIdx[x] = i;            
            if (x == "0") {
                valueIdx[""] = i; // map empty to 0
            }
        }

        if (includeBlank) {
            valueIdx[""] = values.length;
            values.push("(blank)");             
        }

        this._valueIdx = valueIdx;        
        this._possibleValues = values;
    }
    public getGroupByValues() : string []
    {
        return this._possibleValues;
    }

    // undefined if not mapped
    public getGroupByIndex(val : string) : number
    {
        var idx = this._valueIdx[val];
        if (idx == undefined) { // Beware, !0 is true, so check undefined.
            idx = this._valueIdx[""];
        }
        return idx;
    }

    public getColors() : string[]  {
        return this._colors;
    }
}

// Represents statistics about a column. 
// Analyze column contents to infer statistics and type.
export class ColumnStats {
    private _uniques: Array<string>; // array of unique values in this column 
    private _possibleValues: Array<string>; // non-blank, unique values, alphabetically sorted 
    private _numBlanks: number = 0;  // number of blank elements in this column. 
    private _isTagType: boolean; // true if this column is a tag. 

    private _isDate: boolean;

    private _isNumber: boolean;
    private _numberMin: number;
    private _numberMax: number;

    private _grouper : IGrouper;
    private _columnName : string; // Optional

    public isTagType(): boolean { return this._isTagType };
    public isNumberType(): boolean { return this._isNumber; };

    public hasBlanks(): boolean { return this._numBlanks > 0; }

    // Only valid if IsNumberType
    public getNumberRange(): number[] { return [this._numberMin, this._numberMax]; };
    public getPossibleValues(): string[] { return this._possibleValues; }

    // Can this coulmn be used in a group-by?
    
    public isGroupBy() : boolean {return !!this._grouper; }

    // Given a list of recIds (from a cached search result), get a ColumnStats for a 
    // tag column for these recIds. 
    public static NewTagFromRecId(recIds: string[], totalSize: number) {
        // Build a tags array corresponding to the recIds
        var vals: string[] = new Array(totalSize);
        for (var i in recIds) {
            vals[i] = '1';
        }
        return new ColumnStats(null, vals);
    }

    // Create a column stat representing a list of polygon options 
    public static NewFromPolygonList(names: string[]) {
        return new ColumnStats(null, names);
    }

    public getGroupByValues() : string [] {
        return this._grouper.getGroupByValues();

    }
    public getGroupByIndex(val : string)  : number {
        return this._grouper.getGroupByIndex(val);
    }

    public getGroupByColors()  : string[] {
        return this._grouper.getColors();
    }



    // Given the actual values for this column infer the statistics about it. 
    public constructor(columnName : string, vals: string[]) {

        var nonBlank: string[] = []

        this._possibleValues = []; // empty 

        // Really should get this from metadata instead. 
        var isTagType = true; // Tag is either Blank or '1'
        this._isNumber = true;

        for (var i in vals) {
            var val = vals[i];
            if (!val || val.length == 0) {
                this._numBlanks++;
            } else {
                this._possibleValues.push(val);
                if (val != "1" && val != "0") {
                    isTagType = false;
                }

                // Handle percentage (15.1%),  decimal (15.1), integer (15), or blank. 

                // ParseFloat will read up to first non decimal char.
                var num: number;

                if (val[val.length - 1] == '%') {
                    num = parseFloat(val) / 100.0;
                } else if (!isNaN(<any>val)) {
                    num = parseFloat(val);
                }

                if ((num == NaN) ||  num == undefined) { // 
                    this._isNumber = false;
                }
                else 
                {
                    if (this._numberMin) {
                        if (num < this._numberMin) {
                            this._numberMin = num;
                        }
                    } else {
                        this._numberMin = num;
                    }
                    if (this._numberMax) {
                        if (num > this._numberMax) {
                            this._numberMax = num;
                        }
                    } else {
                        this._numberMax = num;
                    }
                } 

                nonBlank.push(val);
            }
        }
        if (this._numBlanks == 0 || this._numBlanks == vals.length) {
            isTagType = false; // Must have at least one occurence of the tag .
        }
        this._isTagType = isTagType;

        if (this._isTagType || !this._numberMin) {
            this._isNumber = false; // tag takes precedence 
        }

        this._possibleValues = Array.from(new Set(this._possibleValues));
        this._possibleValues.sort();

        this._uniques = sortByFrequency(nonBlank);

        this._columnName == columnName;
        if (columnName == "History") 
        {
            this._grouper = new PercentageGrouper();
        } else if (columnName == "Party") 
        {
            var x = new GenericGrouper(["0", "1", "2", "3", "4", "5"], false);
            x._colors = [
                "#BBBBBB",  // 0
                "#FF0000", // 1 = red 
                "#880000", // 2
                "#880088", // 3 
                "#000088", // 4
                "#0000FF" // 5 Blue 
            ]
            this._grouper  = x;
        } else if (this._isTagType) {
            this._grouper = new TagGrouper();

        } else if (this._possibleValues.length < 50 || columnName == "PrecinctName") {
            this._grouper = new GenericGrouper(this._possibleValues, this._numBlanks > 0);
        }
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
            else {
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
