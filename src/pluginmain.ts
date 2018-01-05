// Sample 'Hello World' Plugin template.
// Demonstrates:
// - typescript
// - using trc npm modules and browserify
// - uses promises. 
// - basic scaffolding for error reporting. 
// This calls TRC APIs and binds to specific HTML elements from the page.  

import * as XC from 'trc-httpshim/xclient'
import * as common from 'trc-httpshim/common'

import * as core from 'trc-core/core'

import * as trcSheet from 'trc-sheet/sheet'
import * as trcSheetContents from 'trc-sheet/sheetContents'
import * as trcSheetEx from 'trc-sheet/sheetEx'

import * as plugin from 'trc-web/plugin'
import * as trchtml from 'trc-web/html'


declare var $: any; // external definition for JQuery 

// Provide easy error handle for reporting errors from promises.  Usage:
//   p.catch(showError);
declare var clearError: () => void; // error handler defined in index.html
declare var showError: (error: any) => void; // error handler defined in index.html

export class MyPlugin {
    private _sheet: trcSheet.SheetClient;
    private _pluginClient: plugin.PluginClient;

    public static BrowserEntryAsync(
        auth: plugin.IStart,
        opts: plugin.IPluginOptions
    ): Promise<MyPlugin> {

        var pluginClient = new plugin.PluginClient(auth, opts);

        // Do any IO here...

        var throwError = false; // $$$ remove this

        $("#btnSave").prop('disabled', true);

        var plugin2 = new MyPlugin(pluginClient);
        return plugin2.InitAsync().then(() => {
            if (throwError) {
                throw "some error";
            }

            return plugin2;
        });
    }

    // Expose constructor directly for tests. They can pass in mock versions. 
    public constructor(p: plugin.PluginClient) {
        this._sheet = new trcSheet.SheetClient(p.HttpClient, p.SheetId);
    }


    // Make initial network calls to setup the plugin. 
    // Need this as a separate call from the ctor since ctors aren't async. 
    private InitAsync(): Promise<void> {
        return this.getStats().then(() => {
            return this._sheet.getInfoAsync().then(info => {
                this.updateInfo(info);
            });
        });
    }

    // Display sheet info on HTML page
    public updateInfo(info: trcSheet.ISheetInfoResult): void {
        this._rowCount = info.CountRecords;
        $("#SheetName").text(info.Name);
        $("#ParentSheetName").text(info.ParentName);
        $("#SheetVer").text(info.LatestVersion);
        $("#RowCount").text(info.CountRecords);
    }

    public renderColumnInfo() {

        var data: trcSheetContents.ISheetContents = {};

        var colNames: string[] = [];
        var colValues: string[] = [];

        data["Column Names"] = colNames;
        data["Values"] = colValues;

        for (var columnName in this._columnStats) {
            var values = <ColumnStats> this._columnStats[columnName];

            colNames.push(columnName);

            var text = values.getSummaryString(this._rowCount);
            colValues.push(text);
        }

        var render = new trchtml.RenderSheet("contents", data);
        render.render();
    }

    // Map of ColumnName --> ColumnStats of unique values in this column
    private _columnStats: any;
    private _rowCount: number;


    // Do some sanitizing on the filter expression
    private fixupFilterExpression(filter: string): string {
        if (filter.indexOf("where ") == 0) {
            filter = filter.substr(6);
        }

        if (filter.indexOf("IsInPolygon") != -1) {
            filter = "{geofenced}";
        }
        return filter;
    }

    private getAndRenderChildrenAsync(): Promise<void> {
        return this._sheet.getChildrenAsync().then(children => {
            var data: trcSheetContents.ISheetContents = {};
            var colNames: string[] = [];
            var colFilters: string[] = [];
            data["Name"] = colNames;
            data["Filter Expression"] = colFilters;

            for (var i in children) {
                var child = children[i];
                var name = child.Name;
                var filter = child.Filter;

                if (name && filter) {
                    colNames.push(name);

                    filter = this.fixupFilterExpression(filter);
                    colFilters.push(filter);
                }
            }

            var render = new trchtml.RenderSheet("existingfilters", data);
            render.render();

        });
    };

    // Collect stats on sheets. Namely which columns, and possible values. 
    private getStats(): Promise<void> {
        var values: any = {};

        return this.getAndRenderChildrenAsync()
            .then(() => {
                this._sheet.getSheetContentsAsync().then((contents) => {

                    for (var columnName in contents) {
                        var vals = contents[columnName];

                        var stats = new ColumnStats(vals);
                        
                        values[columnName] = stats;
                    }
                    this._columnStats = values;

                    this.renderColumnInfo();
                });
            });
    }

    // Demonstrate receiving UI handlers 
    public onClickRefresh(): void {
        clearError();
        var filter = $("#filter").val();

        this._sheet.getSheetContentsAsync(filter, ["RecId"]).then(contents => {
            var count = contents["RecId"].length;

            alert("This query has " + count + " rows.");
            $("#btnSave").prop('disabled', false); // Can now save
        }).catch(showError);
    }

    public onChangeFilter() : void {
        // Once we've edited the filter, must get the counts again in order to save it. 
        $("#btnSave").prop('disabled', true);
    }


    public onCreateChild(): void {
        var newName = prompt("Name for sheet?");
        var filter = $("#filter").val();

        var shareSandbox: boolean = true;
        if (this._rowCount > 1000) {
            shareSandbox = false;
        }

        this._sheet.createChildSheetFromFilterAsync(newName, filter, shareSandbox)
            .then(() => this.getAndRenderChildrenAsync()).catch(showError);
    }

    // downloading all contents and rendering them to HTML can take some time. 
    public onGetSheetContents(): void {
        trchtml.Loading("contents");
        //$("#contents").empty();
        //$("#contents").text("Loading...");

        trcSheetEx.SheetEx.InitAsync(this._sheet, null).then((sheetEx) => {
            return this._sheet.getSheetContentsAsync().then((contents) => {
                var render = new trchtml.SheetControl("contents", sheetEx);
                // could set other options on render() here
                render.render();
            }).catch(showError);
        });
    }
}

// https://stackoverflow.com/questions/3579486/sort-a-javascript-array-by-frequency-and-then-filter-repeats
// Return array with duplicates removed and sorted by frequency. 
function sortByFrequency(array : string[]) {
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

class ColumnStats {
    private _uniques: Array<string>;
    private _numBlanks : number = 0;

    public constructor(vals: string[]) {
        
        var nonBlank : string[] = [];
        for(var i in vals)
        {
            var val = vals[i];
            if (!val || val.length == 0) {
                this._numBlanks++;
            } else {
                nonBlank.push(val);
            }
        }

        this._uniques = sortByFrequency(nonBlank);
    }

    // Get a short summary string for the values in this column. 
    public getSummaryString(totalSize: number): string {
        var numBlank: number = this._numBlanks;
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
            text = this._uniques.length + " total unique values";
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
