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
import * as trcPoly from 'trc-sheet/polygonHelper';
import * as trcSheetEx from 'trc-sheet/sheetEx'

import * as plugin from 'trc-web/plugin'
import * as trchtml from 'trc-web/html'
import { ColumnStats } from './columnStats'
import { HashCount } from './hashcount'

declare var $: any; // external definition for JQuery
declare var MarkerClusterer: any; // external definition

// Provide easy error handle for reporting errors from promises.  Usage:
//   p.catch(showError);
declare var clearError: () => void; // error handler defined in index.html
declare var showError: (error: any) => void; // error handler defined in index.html
declare var google: any;
declare var HeatmapOverlay: any;
declare var randomColor: any; // from randomColor()

// $$$ get from TRC
interface IGeoPoint {
    Lat: number;
    Long: number;
}

// List of partitions that we created.
interface IPartition {
    sheetId: string;
    name: string;
    dataId: string; // data for the polygon
    polygon: any; // google maps polygon
    infoWindow: any; // google Info window for displaying polygon name
}

// We create a "virtual column" for the polyons defined in this sheet.
const PolygonColumnName : string = "$IsInPolygon";

export class MyPlugin {
    private _sheet: trcSheet.SheetClient;
    private _pluginClient: plugin.PluginClient;
    private _gps: common.IGeoPointProvider;
    private _polyHelper: trcPoly.PolygonHelper;

    // Used to give each result a unique HTML id.
    private _outputCounter: number = 0;

    // Map of ColumnName --> ColumnStats of unique values in this column
    private _columnStats: any;
    private _rowCount: number; // Total rows

    private _optionFilter: any = [];

    private _lastResults: QueryResults; // Results of last query
    private _opts: plugin.IPluginOptions;
    private _map: any;
    private _markers: any[]; // map markers; { recId: marker }
    private _partitions: { [id: string]: IPartition; }; // Map sheetId --> IPartition
    private _markerCluster: any;

    // $$$ find a way to avoid this.
    private static _pluginId: string = "Geofencing.Beta";

    // $$$ Move to PluginOptionsHelper?
    private getGotoLinkSheet(sheetId: string): string {
        if (this._opts == undefined) {
            return "/"; // avoid a crash
        }
        return this._opts.gotoUrl + "/" + sheetId + "/" +
            MyPlugin._pluginId + "/index.html";
    }

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
        this._polyHelper = new trcPoly.PolygonHelper(this._sheet);

        this._markers = [];
        this._partitions = {};
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

    // Map of polygon names (which are used in the query UX) to
    // a dataId (which is used in the query expression)
    private _polyName2IdMap: any = {};
    public static LatestPolyMap: any; // expose the map outside this class.

    // Collect stats on sheets. Namely which columns, and possible values.
    private getStats(): Promise<void> {
        var values: any = {};

        return this.getAndRenderChildrenAsync()
            .then(() => {
                return this._sheet.listCustomDataAsync(trcSheet.PolygonKind).then(
                    (iter) => {
                        var polyNames: string[] = [];
                        this._polyName2IdMap = null;

                        return iter.ForEach((item) => {
                            var dataId = item.DataId; // unique for API
                            var name = item.Name; // friendly version

                            if (this._polyName2IdMap == null) {
                                this._polyName2IdMap = {};
                            }
                            polyNames.push(name);
                            this._polyName2IdMap[name] = dataId;

                        }).then(() => {
                            if (this._polyName2IdMap != null) {
                                // We have polygon data
                                MyPlugin.LatestPolyMap = this._polyName2IdMap;

                                var stats = ColumnStats.NewFromPolygonList(polyNames);
                                values[PolygonColumnName] = stats;
                            }

                            return this._sheet.getSheetContentsAsync().then((contents) => {

                                for (var columnName in contents) {
                                    var vals = contents[columnName];

                                    var stats = new ColumnStats(vals);

                                    values[columnName] = stats;
                                }
                                this._columnStats = values;

                                this.renderColumnInfo();
                                this.renderQbuilderInfo();
                            }).catch(() => {
                                alert("This sheet does not support querying");
                            });
                        });
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

        this.pauseUI();
        // Columns must exist. verify that Address,City exist before asking for them.
        this._sheet.getSheetContentsAsync(filter, ["RecId", "Address", "City", "Lat", "Long"]).then(contents => {
            var text = this.getResultString(contents);
            this.addResult(filter, text);

            // Don't need to alert, it shows up in the result.
            // this._lastResults = contents;
            // alert("This query has " + count + " rows.");

            var lastResults = new QueryResults(filter, contents);
            this.onEnableSaveOptions(lastResults);
        }).catch(showError)
            .then(() => this.resumeUI());
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
    public onEnableSaveOptions(results: QueryResults): void {
        this._lastResults = results;
        $("#saveOptions").show();
    }

    public onChangeFilter(): void {
        this._lastResults = null;
        // Once we've edited the filter, must get the counts again in order to save it.
        $("#saveOptions").hide();
        $('#map').empty().hide();
        $('#heatmap').empty().hide();
    }

    public onCreateChild(): void {
        var newName = prompt("Name for sheet?");
        var filter = this._lastResults.getExpression();

        var shareSandbox: boolean = true;
        if (this._rowCount > 1000) {
            shareSandbox = false;
        }

        this.pauseUI();
        this._sheet.createChildSheetFromFilterAsync(newName, filter, shareSandbox)
            .then(() => this.getAndRenderChildrenAsync()).catch(showError)
            .then(() => this.resumeUI());
    }

    public onCreateNewTag(): void {
        var newName = prompt("Name for new tag?");
        var filter = this._lastResults.getExpression();

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
            .then(() => this.resumeUI());
    }

    public onCreateMap(): void {
        $('#heatmap').hide();
        $("#map").show();

        var lats = this._lastResults.getLats();
        var lngs = this._lastResults.getLongs();
        var addresses = this._lastResults.getAddresses();
        var cities = this._lastResults.getCities();
        var recIds = this._lastResults.getRecIds();

        var map = this.createGooglemap(lats[0], lngs[0], 'map');

        var infowindow = new google.maps.InfoWindow();
        var bounds = new google.maps.LatLngBounds();

        var marker, i;

        for (i = 0; i < recIds.length; i++) {
            var latLng = new google.maps.LatLng(lats[i], lngs[i])
            marker = new google.maps.Marker({
                position: latLng,
                map: map
            });

            var infoContent = '<div class="info_content">' +
                '<h3>' + recIds[i] + '</h3>' +
                '<p>' + addresses[i] + ', ' + cities[i] + '</p>' +
                '</div>';

            google.maps.event.addListener(marker, 'click', (function (marker, i, infoContent) {
                return function () {
                    infowindow.setContent(infoContent);
                    infowindow.open(map, marker);
                }
            })(marker, i, infoContent));
            bounds.extend(latLng);
        }
        map.fitBounds(bounds);       // auto-zoom
        map.panToBounds(bounds);
    }

    private createGooglemap(lat: string, lng: string, containerId: string): any {
        var myLatlng = new google.maps.LatLng(lat, lng);
        // map options,
        var myOptions = {
            zoom: 14,
            center: myLatlng
        };

        // standard map
        this._map = new google.maps.Map(document.getElementById(containerId), myOptions);

        this._markerCluster = new MarkerClusterer(
            this._map,
            [], { imagePath: 'https://cdn.rawgit.com/googlemaps/js-marker-clusterer/gh-pages/images/m' });

        this.FinishInit(() => { } );

        this.initDrawingManager(this._map); // adds drawing capability to map

        return this._map;
    }

    public onCreateHeatMap(): void {
        $("#map").hide();
        $('#heatmap').show();

        var data = this.getHeatmapData();
        this.createHeatmap(data, "heatmap");
    }

    private getHeatmapData(): any {

        var lats = this._lastResults.getLats();
        var lngs = this._lastResults.getLongs();

        let count = lats.length;

        var dic: any = {};

        var max: number = 0;

        for (let i: number = 0; i < count; i++) {

            let lat = lats[i];
            let lng = lngs[i];

            let key = "".concat(lat, lng);
            if (!key) continue;

            if (!dic[key]) {
                dic[key] = { lat: lat, lng: lng, count: 1 }
            }
            else {
                dic[key]["count"]++;
                if (dic[key]["count"] > max) { max = dic[key]["count"]; }
            }
        }

        var keys = Object.keys(dic);
        let dataArray = new Array();

        keys.forEach(key => {
            dataArray.push(dic[key]);
        });

        return { max: max, data: dataArray };
    }

    private createHeatmap(data: any, containerId: string): void {

        var map = this.createGooglemap(data.data[0].lat, data.data[0].lng, containerId);

        // heatmap layer
        var heatmap = new HeatmapOverlay(map,
            {
                // radius should be small ONLY if scaleRadius is true (or small radius is intended)
                "radius": 10,
                "maxOpacity": .5,
                // scales the radius based on map zoom
                "scaleRadius": false,
                // if set to false the heatmap uses the global maximum for colorization
                // if activated: uses the data maximum within the current map boundaries
                //   (there will always be a red spot with useLocalExtremas true)
                "useLocalExtrema": true,
                // which field name in your data represents the latitude - default "lat"
                latField: 'lat',
                // which field name in your data represents the longitude - default "lng"
                lngField: 'lng',
                // which field name in your data represents the data value - default "value"
                valueField: 'count'
            }
        );

        heatmap.setData(data);
    }

    private pauseUI(): void {
        // freeze UI controls that would let you modify a query
        //disable filter inputs
        $('.filter-input').find('input, textarea, button, select').prop('disabled', true);
    }
    private resumeUI(): void {
        //resume filter inputs
        $('.filter-input').find('input, textarea, button, select').prop('disabled', false);
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
                    var bday: boolean = isDateColumn(columnName);
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

                    if (columnName == PolygonColumnName)
                    {
                        // This represents the polygons.
                        // Polygon comparison is either in or out.
                        operators = [
                            JQBOperator.Equal, JQBOperator.NotEqual
                            ];
                    }

                    if (!bday && (valueLength < 30)) {
                        // If short enough list, show as a dropdown with discrete values.
                        input = JQBInput.Select;
                        values = getPossibleValues;
                    }
                }

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
        }).queryBuilder({
            //plugins: ['bt-tooltip-errors'],

            filters: this._optionFilter,
            sort_filters: true

        });
    }

    public onResetRule(): void {
        // Reset filter rules
        $("#builder-basic").queryBuilder('reset');
    }

    // Debug helper
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

    // Performance note: Do all the UI upfront and then do all the map updates (add polygons, etc).
    // It's a *huge* performance penalty to interleave them because it prevents map rendering
    // from being batched up and done all at once.
    private BuildPartitions(
        children: trcSheet.IGetChildrenResultEntry[],
        callback: () => void
    ): void {
        var _missing = 0;
        var _extra: any = {};
        var remaining = children.length;

        // Second pass. After we collect all the IO, then update the map.
        var next = () => {
            remaining--;
            if (remaining == 0) {
                for (var sheetId in this._partitions) {
                    var partition = this._partitions[sheetId];
                    var polySchema = _extra[sheetId].polySchema;
                    var count = _extra[sheetId].count;

                    partition.polygon = MyPlugin.newPolygon(polySchema, this._map);
                    this.physicallyAddPolygon(
                        partition.name,
                        partition.polygon,
                        count,
                        partition.sheetId);
                }


                callback();
            }
        };

        if (children.length == 0) {
            remaining = 1;
            next();
            return;
        }

        // Do the first pass for all IO.
        // Dispatch IO in parallel.
        for (var i = 0; i < children.length; i++) {
            var _child = children[i];

            ((child: trcSheet.IGetChildrenResultEntry) => {
                var sheetId = child.Id;
                var childSheet = this._sheet.getSheetById(sheetId);
                childSheet.getInfoAsync().then(childInfo => {
                    var filter = child.Filter;
                    var dataId = MyPlugin.GetPolygonIdFromFilter(filter);

                    if (dataId == null) {
                        // there are child sheets without polygon data. Warn!!
                        _missing++;
                        next();
                    } else {
                        this._polyHelper.getPolygonByIdAsync(dataId).then((polySchema) => {
                            if (polySchema == null) {
                                _missing++;
                            }
                            else {
                                _extra[sheetId] = {
                                    polySchema: polySchema,
                                    count: childInfo.CountRecords
                                };
                                this._partitions[sheetId] = {
                                    sheetId: sheetId,
                                    name: child.Name,
                                    dataId: dataId,
                                    polygon: null, // fill in later.
                                    infoWindow: null
                                };
                            }
                            next();
                        });
                    }
                });
            })(_child); // closure
        }
    }

    // https://developers.google.com/maps/documentation/javascript/examples/polygon-simple
    static newPolygon(schema: trcSheet.IPolygonSchema, map: any): any {
        var coords: any = [];
        for (var i = 0; i < schema.Lat.length; i++) {
            coords.push({
                lat: schema.Lat[i],
                lng: schema.Long[i]
            })
        }

        var polygon = new google.maps.Polygon({
            paths: coords,
            strokeColor: '#FF0000',
            strokeOpacity: 0.8,
            strokeWeight: 2,
            fillColor: '#FF0000',
            fillOpacity: 0.35,
            editable: true
        });
        polygon.setMap(map);

        return polygon;
    }

    // https://developers.google.com/maps/documentation/javascript/examples/polygon-arrays
    // Convert a google polgyon to a TRC array
    static getVertices(polygon: any): IGeoPoint[] {
        var vertices = polygon.getPath();

        var result: IGeoPoint[] = [];

        for (var i = 0; i < vertices.getLength(); i++) {
            var xy = vertices.getAt(i);
            result.push({ Lat: xy.lat(), Long: xy.lng() });
        }
        return result;
    }


    // add drawing capability to map
    private initDrawingManager(map: any) {
        var drawingManager = new google.maps.drawing.DrawingManager({
            drawingMode: google.maps.drawing.OverlayType.POLYGON,
            drawingControlOptions: {
                position: google.maps.ControlPosition.TOP_CENTER,
                drawingModes: [
                    google.maps.drawing.OverlayType.POLYGON
                ]
            },
            polygonOptions: {
                editable: true
            }
        });

        // add event listener for when shape is drawn
        google.maps.event.addListener(drawingManager, 'overlaycomplete', (event: any) => {
            var polygon = event.overlay;
            var countInside = this.countNumberInPolygon(polygon);

            if (countInside === 0) {
                alert("No records found in polygon");
                event.overlay.setMap(null); // remove polygon
            } else {
                var walklistName = prompt("Name of walklist");

                if (walklistName === null) {
                    event.overlay.setMap(null); // remove polygon
                } else if (walklistName === "") {
                    alert("Walklist name can't be empty");
                    event.overlay.setMap(null);
                } else {
                    this.createWalklist(walklistName, countInside, polygon);
                }

            }
        });

        drawingManager.setMap(map);
    }

    // remove polygon/polyline from global var _polygons
    private removeGlobalPolygon(sheetId: string) {
        var partition = this._partitions[sheetId];

        var infoWindow = partition.infoWindow;
        if (infoWindow != null) {
            infoWindow.close();
        }

        var polygon = partition.polygon;
        polygon.setMap(null);
        delete this._partitions[sheetId];
    }

    // Called when we finish drawing a polygon and confirmed we want to create a walklist.
    private createWalklist(partitionName: string, countInside: number, polygon: any) {
        var vertices = MyPlugin.getVertices(polygon);
        return this._polyHelper.createPolygon(partitionName, vertices).then((dataId) => {

            var filter = MyPlugin.CreateFilter(dataId);
            return this._sheet.createChildSheetFromFilterAsync(partitionName, filter, false).then((childSheet: trcSheet.SheetClient) => {
                var sheetId = childSheet.getId();

                this._partitions[sheetId] = {
                    sheetId: sheetId,
                    name: partitionName,
                    dataId: dataId,
                    polygon: polygon,
                    infoWindow: null // assign later
                };

                this.physicallyAddPolygon(partitionName, polygon, countInside, sheetId);
                //this.updateClusterMap();

                this.updateQbuilderFilter(partitionName, dataId);
            });
        });
    }

    private updateQbuilderFilter(walklistName: string, dataId: string) {
        //update filter for new polygon
        for (var i = 0; i < this._optionFilter.length; i++) {
            var key = this._optionFilter[i];

            if (key.id == PolygonColumnName) {
                let nextKey = key.values.length;
                key.values[nextKey] = walklistName

                this._optionFilter[i]['values'] = key.values;
            }
            break;
        }
        var builder = $('#builder-basic');
        builder.queryBuilder('setFilters', this._optionFilter);

        var rule = builder.queryBuilder('getRules');

        var newRule = {
            id: PolygonColumnName,
            operator: 'equal',
            value: walklistName
        };

        rule.rules.push(newRule);
        builder.queryBuilder('setRules', rule);

        MyPlugin.LatestPolyMap[walklistName] = dataId;

        $('#btnGetContent').click();
    }

    // Helper to get the center of a polygon. Useful for adding a label.
    // http://stackoverflow.com/questions/3081021/how-to-get-the-center-of-a-polygon-in-google-maps-v3
    private static polygonCenter(poly: any): any {
        var lowx: number,
            highx: number,
            lowy: number,
            highy: number,
            lats: number[] = [],
            lngs: number[] = [],
            vertices = poly.getPath();

        for (var i = 0; i < vertices.length; i++) {
            lngs.push(vertices.getAt(i).lng());
            lats.push(vertices.getAt(i).lat());
        }

        lats.sort();
        lngs.sort();
        lowx = lats[0];
        highx = lats[vertices.length - 1];
        lowy = lngs[0];
        highy = lngs[vertices.length - 1];
        var center_x = lowx + ((highx - lowx) / 2);
        var center_y = lowy + ((highy - lowy) / 2);
        return (new google.maps.LatLng(center_x, center_y));
    }

    private physicallyAddPolygon(partitionName: string, polygon: any, count: number, sheetId: string): void {
        var color = randomColor();

        //this.addPolygonResizeEvents(polygon, sheetId);
        this.fillPolygon(polygon, color);
      //  this.hideMarkers(polygon);
        this.addPolygonResizeEvents(polygon, sheetId);

        // Add a label to the polygon.
        var location = MyPlugin.polygonCenter(polygon);
        var infoWindow = new google.maps.InfoWindow({
            content: partitionName + "(" + count + ")",
            position: location
        });
        infoWindow.open(this._map);
        this._partitions[sheetId].infoWindow = infoWindow;
    }

    private fillPolygon(polygon: any, color: any) {
        polygon.setOptions({
            fillColor: color,
            fillOpacity: .35
        });
    }


    // $$$ This should be migrated to just update the Polygon Data.
    // Then rerunning the filter will pick up the new boundary
    private updatePolygonBoundary(sheetId: string) {
        var partition = this._partitions[sheetId];
        var polygon = partition.polygon;
        var vertices = MyPlugin.getVertices(polygon);

        return this._polyHelper.updatePolygonAsync(partition.dataId, partition.name, vertices).then(
            (dataId: string) => {
                // $$$ - UI update.If we shrink the polygon, we should add back old markers.
                // If we shrunk, show old values. (like a delete)
                // If we grew, show new values.
               // this.hideMarkers(polygon);
                //this.updateClusterMap();
            });
    }


    // event listeners for when polygon shape is modified
    private addPolygonResizeEvents(polygon: any, sheetId: string) {
        google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
            this.updatePolygonBoundary(sheetId);
        });

        google.maps.event.addListener(polygon.getPath(), 'insert_at', () => {
            this.updatePolygonBoundary(sheetId);
        });
    }

    private FinishInit(callback: () => void): void {
        var other = 0;
        // Get existing child sheets
        this._sheet.getChildrenAsync().then(children => {
            this.BuildPartitions(children, () => {
                callback();
            });
        });
    }

    // Create TRC filter expression to refer to this polygon
    private static CreateFilter(dataId: string): string {
        return "IsInPolygon('" + dataId + "',Lat,Long)";
    }

    // Reverse of CreateFilter expression. Gets the DataId back out.
    // Returns null if not found
    public static GetPolygonIdFromFilter(filter: string): string {
        if (filter == null) {
            return null;
        }
        var n = filter.match(/IsInPolygon.'(.+)',Lat,Long/i);
        if (n == null) {
            return null;
        }
        var dataId = n[1];
        return dataId;
    }

    private forEachInPolygin(
        polygon: any,
        predicate: (idx: number) => void
    ): void {

        var lats = this._lastResults.getLats();
        var lngs = this._lastResults.getLongs();

        let count = lats.length;

        for (let i: number = 0; i < count; i++) {

            let lat = lats[i];
            let lng = lngs[i];

            if (this.isInsidePolygon(lat, lng, polygon)) {
                predicate(i);
            }
        }
    }

    // returns true if lat/lng coordinates are inside drawn polygon,
    // false otherwise
    private isInsidePolygon(lat: any, lng: any, poly: any) {
        var coords = new google.maps.LatLng(lat, lng);

        var result = google.maps.geometry.poly.containsLocation(coords, poly);
        return result;
    }

    private countNumberInPolygon(polygon: any): number {
        var total = 0;
        this.forEachInPolygin(polygon,
            (idx) => {
                total++;
            });
        return total;
    }

} // End class Plugin


class QueryResults {
    private _lastResults: trcSheetContents.ISheetContents; // Results of last query
    private _expression: string; // the filter expression used to run and get these results

    public constructor(expression: string, results: trcSheetContents.ISheetContents) {
        this._lastResults = results;
        this._expression = expression;
    }

    public getRecIds(): string[] {
        return this._lastResults["RecId"];
    }

    public getExpression(): string {
        return this._expression;
    }

    public getLats(): string[] {
        return this._lastResults["Lat"];
    }

    public getLongs(): string[] {
        return this._lastResults["Long"];
    }

    public getAddresses(): string[] {
        return this._lastResults["Address"];
    }

    public getCities(): string[] {
        return this._lastResults["City"];
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

    // Polygons
    if (asRule.field == PolygonColumnName) {
        // Convert Name to DataId.
        var dataName = asRule.value;
        var dataId = MyPlugin.LatestPolyMap[dataName];
        if (!dataId) {
            return "false";
        }
        else {
            var opStr :string;
            if (asRule.operator == JQBOperator.Equal) {
                opStr = "";
            } else if (asRule.operator == JQBOperator.NotEqual) {
                opStr = "!";
            }

            return "(" + opStr + "IsInPolygon('" + dataId + "',Lat,Long))";
        }
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
    if (isDateColumn(field)) {
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
function isDateColumn(columnName: string): boolean {
    return columnName == "Birthday" || columnName == "Birthdate";
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