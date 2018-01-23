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
import { ColumnStats } from './columnStats'
import { HashCount } from './hashcount'

declare var $: any; // external definition for JQuery

// Provide easy error handle for reporting errors from promises.  Usage:
//   p.catch(showError);
declare var clearError: () => void; // error handler defined in index.html
declare var showError: (error: any) => void; // error handler defined in index.html

export class MyPlugin {
    private _sheet: trcSheet.SheetClient;
    private _pluginClient: plugin.PluginClient;
    private _gps : common.IGeoPointProvider;

    // Used to give each result a unique HTML id.
    private _outputCounter: number = 0;

    // Map of ColumnName --> ColumnStats of unique values in this column
    private _columnStats: any;
    private _rowCount: number;

    private _optionFilter: any = [];

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
            var values = <ColumnStats>this._columnStats[columnName];

            colNames.push(columnName);

            var text = values.getSummaryString(this._rowCount);
            colValues.push(text);
        }

        var render = new trchtml.RenderSheet("contents", data);

        render.render();
    }

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

                    this.renderQbuilderInfo();
                });
            });
    }

    // Demonstrate receiving UI handlers
    public onClickRefresh(): void {
        clearError();
        var filter = $("#filter").val();

        // Columns must exist. verify that Address,City exist before asking for them.
        this._sheet.getSheetContentsAsync(filter, ["RecId", "Address", "City"]).then(contents => {
            // var count = contents["RecId"].length;

            var text = this.getResultString(contents);
            this.addResult(filter, text);

            // Don't need to alert, it shows up in the result.
            // alert("This query has " + count + " rows.");

            $("#btnSave").prop('disabled', false); // Can now save
        }).catch(showError);
    }

    // Given query results, scan it and convert to a string.
    private getResultString(contents : trcSheetContents.ISheetContents) : string
    {
        var count = contents["RecId"].length;

        var text = count + " rows";

        // Check for households
        var addrColumn = contents["Address"];
        var cityColumn = contents["City"];
        if (addrColumn && cityColumn)
        {
            var uniqueAddrs = new HashCount();
            for(var i in addrColumn)
            {
                var addr = addrColumn[i] + "," + cityColumn[i];
                uniqueAddrs.Add(addr);
            }

            var countAddrs = uniqueAddrs.getCount();

            text +="; " + countAddrs + " households";
        }
        return text;
    }

    // Add the result to the html log.
    private addResult(filter: string, result: string): void {
        this._outputCounter++;

        // Add to output log.
        var root = $("#prevresults");

        var id = "result_" + this._outputCounter;
        var e1 = $("<tr id='" + id + "'>");
        var e2a = $("<td>").text(filter);

        // If we have richer results, this could be a more complex html object.
        var e2b = $("<td>").text(result);

        var e2c = $("<td>");
        var e3 = $("<button>").text("[remove]").click(() => {
            $("#" + id).remove();
        });
        e2c.append(e3);

        e1.append(e2a);
        e1.append(e2b);
        e1.append(e2c);

        // Show most recent results at top, but after the first <tr> that serves as header
        //$('#prevresults thead:first').after(e1);
        $('#prevresults').prepend(e1);
        //root.prepend(e1);
    }

    public onChangeFilter(): void {
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

    // Display sheet info on HTML page
    public renderQbuilderInfo(): void {

        for (var columnName in this._columnStats)
        {
            var culumnDetail = <ColumnStats>this._columnStats[columnName];
            var text = culumnDetail.getSummaryString(this._rowCount);
            var isTagType = culumnDetail.isTagType();
            var getPossibleValues = culumnDetail.getPossibleValues();

            var optionsData : any = {};

            var type = "string";
            var input = "text";
            var operators = ['equal', 'not_equal', 'is_empty', 'is_not_empty'];
            var values : any = {};

            var valueLength = getPossibleValues.length;

            if (valueLength > 0) {

                if (valueLength < 10)
                {
                    type = "integer";
                    input = "select";
                } else if ( isTagType === true)
                {
                    type = "integer";
                    input = "radio";
                    operators = ['equal'];
                }
                var options : any = [];
                if ((input == "radio") || (input == "select")) {
                    values = text.split(',');
                }

                var fields : any = {
                    'id' : columnName,
                    'label' : columnName,
                    'type' : type,
                    'input' : input,
                    'values' : values,
                    'operators' : operators
                }
                this._optionFilter.push(fields);
            }
        }

        $('#builder-basic').queryBuilder({
            //plugins: ['bt-tooltip-errors'],

            filters: this._optionFilter

        });
    }

    public onResetRule(): void {
        // Reset filter rules
        $("#builder-basic").queryBuilder('reset');
    }

    public onGetRule(): void {
        // Reset filter rules
        var result = $('#builder-basic').queryBuilder('getRules');

        if (!$.isEmptyObject(result)) {
            alert(JSON.stringify(result, null, 2));

            var expr = convertToExpressionString(result);
            alert(expr);
        }
    }

    // downloading all contents and rendering them to HTML can take some time.
    public onGetSheetContents(): void {

        clearError();
        var query = $('#builder-basic').queryBuilder('getRules');
        var queryFilter = convertToExpressionString(query);

        // Columns must exist. verify that Address,City exist before asking for them.
        this._sheet.getSheetContentsAsync(queryFilter, ["RecId", "Address", "City"]).then(contents => {
            // var count = contents["RecId"].length;

            var text = this.getResultString(contents);

            this.addQueryBuilderResult(queryFilter, text);

        }).catch(showError);
    }

    // Add the result to the html log.
    private addQueryBuilderResult(filter: string, result: string): void {
        this._outputCounter++;

        // Add to output log.
        var root = $("#qb-prevresults");

        var id = "result_" + this._outputCounter;
        var e1 = $("<tr id='" + id + "'>");
        var e2a = $("<td>").text(filter);

        // If we have richer results, this could be a more complex html object.
        var e2b = $("<td>").text(result);

        var e2c = $("<td>");
        var e3 = $("<button>").text("[remove]").click(() => {
            $("#" + id).remove();
        });
        e2c.append(e3);

        e1.append(e2a);
        e1.append(e2b);
        e1.append(e2c);

        // Show most recent results at top, but after the first <tr> that serves as header
        //$('#prevresults thead:first').after(e1);
        $('#qb-prevresults').prepend(e1);
        //root.prepend(e1);
    }
}


function  convertConditionToExpressionString(asQuery : IQueryCondition) : string
{
    var opStr : string;
    if ( asQuery.condition == "AND")
    {
        opStr = " && ";
    }  else if (asQuery.condition == "OR")
    {
        opStr = " || ";
    } else {
        throw "Unsupported operator: " + asQuery.condition;
    }

    var expressionStr : string = "(";
    for(var i in asQuery.rules)
    {
        if (expressionStr.length > 1)
        {
            expressionStr += opStr;
        }
        expressionStr += convertToExpressionString(asQuery.rules[i]);
    }
    expressionStr += ")";

    return expressionStr;
}

function  convertRuleToExpressionString(asRule : IQueryRule) : string
{
    // Unary operators don't have a value
    // "is_empty", "is_not_empty"
    if (asRule.operator == JQBOperator.IsEmpty)
    {
        return "IsBlank(" + asRule.field + ")";
    }
    if (asRule.operator == JQBOperator.IsNotEmpty)
    {
        return "(!IsBlank(" + asRule.field + "))";
    }

    // We have a binary operator.

    // Add value
    var valueStr : string;
    var isString: boolean = false;
    var isNumber : boolean = false;
    if (asRule.type == JQBType.String)
    {
        isString = true;
        valueStr = "'" + asRule.value + "'"; // strings are enclosed in single quotes.
    } else if (asRule.type == JQBType.Integer)
    {
        isNumber = true;
        valueStr += asRule.value;
    } else {
        throw "Unhandled value type: " + asRule.type;
    }

    // TODO - check isString, isNumber, etc and make sure operator is supported
    var opStr : string = null;
    if (asRule.operator == JQBOperator.Equal)
    {
        opStr = " == ";
    } else if (asRule.operator ==  JQBOperator.NotEqual)
    {
        opStr = " != ";
    }else {
        throw "Unhandled operator type: " + asRule.operator;
    }
    // TODO -  Add other operators here

    var expressionStr = "(" + asRule.field + opStr + valueStr + ")";
    return expressionStr;
}

 // Given a JQueryBuilder object, convert it to a TRC string.
 // The query object is a potentially recursive tree.
function  convertToExpressionString(query : IQueryCondition | IQueryRule) : string
{
    var asQuery = (<IQueryCondition>query);
    if (asQuery.condition)
    {
        return convertConditionToExpressionString(asQuery);
    }

    var asRule = (<IQueryRule> query);
    {
        return convertRuleToExpressionString(asRule);
    }
}

// Constant values for JQueryBuilder Types and Operators.
class JQBType
{
    public static String = "string";
    public static Integer = "integer";
    public static Boolean = "boolean";
}
class JQBOperator
{
    public static Equal = "equal";
    public static NotEqual = "not_equal";
    public static IsEmpty = "is_empty";
    public static IsNotEmpty = "is_not_empty";
}

// TypeScript Definitions of query from http://querybuilder.js.org/#advanced
// This can form a recursive tree.
interface IQueryRule {
    id : string;
    field : string;
    type : string;
    input : string; // string, integer, double, date, time, datetime and boolean.
    operator : string; // "equal", "not_equal", "less", "less_or_equal", "greater", "greater_or_equal", "is_empty", "is_not_empty"
    value : string;
}
interface IQueryCondition {
    condition : string; // "AND", "OR"
    rules : IQueryRule[]|IQueryCondition[]
}