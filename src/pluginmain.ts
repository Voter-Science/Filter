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
    private _gps: common.IGeoPointProvider;

    // Used to give each result a unique HTML id.
    private _outputCounter: number = 0;

    // Map of ColumnName --> ColumnStats of unique values in this column
    private _columnStats: any;
    private _rowCount: number; // Total rows

    private _optionFilter: any = [];

    private _lastResults: QueryResults; // Results of last query 

    public static BrowserEntryAsync(
        auth: plugin.IStart,
        opts: plugin.IPluginOptions
    ): Promise<MyPlugin> {

        var pluginClient = new plugin.PluginClient(auth, opts);

        // Do any IO here...

        var throwError = false; // $$$ remove this

        // $("#btnSave").prop('disabled', true);
        
        var plugin2 = new MyPlugin(pluginClient);
        plugin2.onChangeFilter(); // disable the Save buttons 

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
                }).catch( ()=> {
                    alert("This sheet does not support querying");
                });
            });
    }

    // Demonstrate receiving UI handlers
    public onRunQueryAdvanced(): void {
        var filter = $("#filter").val();

        this.showFilterResult(filter);
    }

    // Add the result to the html log.
    private showFilterResult(filter: string): void {
        clearError();
        this.onChangeFilter();

        // Columns must exist. verify that Address,City exist before asking for them.
        this._sheet.getSheetContentsAsync(filter, ["RecId", "Address", "City", "Lat", "Long"]).then(contents => {
            var text = this.getResultString(contents);
            this.addResult(filter, text);

            // Don't need to alert, it shows up in the result.
            // this._lastResults = contents;
            // alert("This query has " + count + " rows.");

            var lastResults = new QueryResults(filter, contents);
            this.onEnableSaveOptions(lastResults);
        }).catch(showError);
    }

    // Given query results, scan it and convert to a string.
    private getResultString(contents: trcSheetContents.ISheetContents): string {
        var count = contents["RecId"].length;

        var text = count + " rows";

        // Check for households
        var addrColumn = contents["Address"];
        var cityColumn = contents["City"];
        if (addrColumn && cityColumn) {
            var uniqueAddrs = new HashCount();
            for (var i in addrColumn) {
                var addr = addrColumn[i] + "," + cityColumn[i];
                uniqueAddrs.Add(addr);
            }

            var countAddrs = uniqueAddrs.getCount();

            text += "; " + countAddrs + " households";
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

    // Called afer a successful query. 
    public onEnableSaveOptions(results : QueryResults): void {
        this._lastResults = results;
        //$("#btnSave").prop('disabled', false);
        $("#saveOptions").show();
    }

    public onChangeFilter(): void {
        this._lastResults = null;
        // Once we've edited the filter, must get the counts again in order to save it.
        //$("#btnSave").prop('disabled', true);
        $("#saveOptions").hide();
    }

    public onCreateChild(): void {
        var newName = prompt("Name for sheet?");
        var filter = this._lastResults._expression;

        var shareSandbox: boolean = true;
        if (this._rowCount > 1000) {
            shareSandbox = false;
        }

        this.pauseUI();
        this._sheet.createChildSheetFromFilterAsync(newName, filter, shareSandbox)
            .then(() => this.getAndRenderChildrenAsync()).catch(showError)
            .then( () => this.resumeUI());
    }

    public onCreateNewTag(): void {
        var newName = prompt("Name for new tag?");
        var filter = this._lastResults._expression;

        var recIds = this._lastResults.getRecIds();

        var admin = new trcSheet.SheetAdminClient(this._sheet);

        var col: any = {
            ColumnName: newName,
            Description: null,
            PossibleValues: null,
            Expression: filter // $$$ not on interface 
        };
        var col2: trcSheet.IMaintenanceAddColumn = col;
        // var cols : 

        this.pauseUI();
        admin.postNewExpressionAsync(newName, filter).then(() => {
            // Rather than have server recompute, just pull the last saved query results. 
            this._columnStats[newName] = ColumnStats.NewTagFromRecId(recIds, this._rowCount);
            this.renderColumnInfo();            
            this.renderQbuilderInfo();
        }).catch(showError)
        .then( () => this.resumeUI());
    }

    private pauseUI() : void 
    {
// Todo - freeze UI controls that would let you modify a query or 
    }
    private resumeUI() : void 
    {

    }

    // Display sheet info on HTML page
    public renderQbuilderInfo(): void {

        this._optionFilter = [];

        for (var columnName in this._columnStats) {
            var columnDetail = <ColumnStats>this._columnStats[columnName];

            var getPossibleValues = columnDetail.getPossibleValues();

            var valueLength = getPossibleValues.length;

            if (valueLength > 0) {
                var isTagType = columnDetail.isTagType();
                var optionsData: any = {};

                var type: string; // JQBType
                var input: string; // JQBInput;
                var operators: string[]; // JQBOperator[]
                var values: any = {};

                if (isTagType) {
                    type = JQBType.Boolean;
                    input = JQBInput.Radio;
                    operators = [JQBOperator.Equal];
                    values = [TagValues.True, TagValues.False];
                }
                else {  
                    var bday :boolean = isDateColumn(columnName);                  
                    if (bday || columnDetail.isNumberType()) {
                        type = JQBType.Double;
                        input = JQBInput.Number;
                        operators = [ // Numberical operations
                            JQBOperator.Equal, JQBOperator.NotEqual,
                            JQBOperator.IsEmpty, JQBOperator.IsNotEmpty,
                            JQBOperator.Less, JQBOperator.LessOrEqual,
                            JQBOperator.Greater, JQBOperator.GreaterOrEqual
                        ];
                    } else {
                        type = JQBType.String;
                        input = JQBInput.Text;
                        operators = [ // String operators.
                            JQBOperator.Equal, JQBOperator.NotEqual, JQBOperator.IsEmpty, JQBOperator.IsNotEmpty];
                    }

                    if (!bday && (valueLength < 10)) {
                        // If short enough list, show as a dropdown with discrete values.
                        input = JQBInput.Select;
                        values = getPossibleValues;
                    }
                }

                var options: any = [];

                var fields: any = {
                    'id': columnName,
                    'label': columnName,
                    'type': type,
                    'input': input,
                    'values': values,
                    'operators': operators
                }
                this._optionFilter.push(fields);
            }
        }

        $('#builder-basic').on("change.queryBuilder", () => {
            //handle onchange event of query builder
            this.onChangeFilter();
        }) .queryBuilder({
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
    public onRunQueryBuilder(): void {
        var query = $('#builder-basic').queryBuilder('getRules');
        var filter = convertToExpressionString(query);

        this.showFilterResult(filter);
    }
} // End class Plugin 


class QueryResults
{
    public _lastResults: trcSheetContents.ISheetContents; // Results of last query 
    public _expression: string; // the filter expression used to run and get these results    

    public constructor(expression : string, results : trcSheetContents.ISheetContents)
    {
        this._lastResults = results;
        this._expression = expression;
    }

    public getRecIds() : string[] {
        return this._lastResults["RecId"];
    }
}


function convertConditionToExpressionString(asQuery: IQueryCondition): string {
    var opStr: string;
    if (asQuery.condition == "AND") {
        opStr = " && ";
    } else if (asQuery.condition == "OR") {
        opStr = " || ";
    } else {
        throw "Unsupported operator: " + asQuery.condition;
    }

    var expressionStr: string = "(";
    for (var i in asQuery.rules) {
        if (expressionStr.length > 1) {
            expressionStr += opStr;
        }
        expressionStr += convertToExpressionString(asQuery.rules[i]);
    }
    expressionStr += ")";

    return expressionStr;
}

function convertRuleToExpressionString(asRule: IQueryRule): string {
    // Unary operators don't have a value
    // "is_empty", "is_not_empty"
    if (asRule.operator == JQBOperator.IsEmpty) {
        return "IsBlank(" + asRule.field + ")";
    }
    if (asRule.operator == JQBOperator.IsNotEmpty) {
        return "(!IsBlank(" + asRule.field + "))";
    }

    // We have a binary operator.

    // Add value
    var valueStr: string;
    var isString: boolean = false;
    var isNumber: boolean = false;

    if (asRule.type == JQBType.Boolean) {
        if (asRule.value == TagValues.True) {
            return "(IsTrue(" + asRule.field + "))";
        } else {
            return "(IsFalse(" + asRule.field + "))";
        }
    } else if (asRule.type == JQBType.String) {
        isString = true;
        valueStr = "'" + asRule.value + "'"; // strings are enclosed in single quotes.
    } else if (asRule.type == JQBType.Double) {
        isNumber = true;
        valueStr = asRule.value;
    } else {
        throw "Unhandled value type: " + asRule.type;
    }

    // TODO - check isString, isNumber, etc and make sure operator is supported
    var opStr: string = null;
    if (asRule.operator == JQBOperator.Equal) {
        opStr = " == ";
    } else if (asRule.operator == JQBOperator.NotEqual) {
        opStr = " != ";
    } else if (asRule.operator == JQBOperator.Less) {
        opStr = " < ";
    } else if (asRule.operator == JQBOperator.LessOrEqual) {
        opStr = " <= ";
    } else if (asRule.operator == JQBOperator.Greater) {
        opStr = " > ";
    } else if (asRule.operator == JQBOperator.GreaterOrEqual) {
        opStr = " >= ";
    } else {
        throw "Unhandled operator type: " + asRule.operator;
    }
    // TODO -  Add other operators here

    var field = asRule.field;
    if (isDateColumn(field))
    {
        field = "(Age(" + field + "))";
    }

    var expressionStr = "(" + field + opStr + valueStr + ")";
    return expressionStr;
}

// Given a JQueryBuilder object, convert it to a TRC string.
// The query object is a potentially recursive tree.
function convertToExpressionString(query: IQueryCondition | IQueryRule): string {
    try {
        var asQuery = (<IQueryCondition>query);
        if (asQuery.condition) {
            return convertConditionToExpressionString(asQuery);
        }

        var asRule = (<IQueryRule>query);
        {
            return convertRuleToExpressionString(asRule);
        }
    } catch (e) {
        alert("Error building expression:" + e);
    }
}

// TODO - we need a better way of detecting if it's a date. 
function isDateColumn(columnName : string) : boolean
{
    return columnName == "Birthday";
}

class TagValues {
    public static True = "true";
    public static False = "false";
}

// Constant values for JQueryBuilder Types and Operators.
class JQBInput // Type of input control
{
    public static Text = "text";
    public static Number = "number";
    public static Select = "select"; // dropdown
    public static Radio = "radio";
}

class JQBType {
    public static String = "string";
    // public static Integer = "integer"; // use Double instead
    public static Double = "double";
    public static Boolean = "boolean";
}
class JQBOperator {
    public static Equal = "equal";
    public static NotEqual = "not_equal";
    public static IsEmpty = "is_empty";
    public static IsNotEmpty = "is_not_empty";
    public static Less = "less";
    public static LessOrEqual = "less_or_equal";
    public static Greater = "greater";
    public static GreaterOrEqual = "greater_or_equal";
}

// TypeScript Definitions of query from http://querybuilder.js.org/#advanced
// This can form a recursive tree.
interface IQueryRule {
    id: string;
    field: string;
    type: string; // string, integer, double, date, time, datetime and boolean.
    input: string;  // JQBInput
    operator: string; // "equal", "not_equal", "less", "less_or_equal", "greater", "greater_or_equal", "is_empty", "is_not_empty"
    value: string;
}
interface IQueryCondition {
    condition: string; // "AND", "OR"
    rules: IQueryRule[] | IQueryCondition[]
}