var d3 = require('d3');
var debug = require('debug')('transitive');
var Emitter = require('emitter');
var toFunction = require('to-function');
var each = require('each');
var clone = require('clone');

var Display = require('./display');
var Graph = require('./graph');
var NetworkPath = require('./path');
var Route = require('./route');
var RoutePattern = require('./pattern');
var Journey = require('./journey');
var Stop = require('./point/stop');
var Place = require('./point/place');
var Styler = require('./styler');
var Segment = require('./segment');
var Labeler = require('./labeler');
var Label = require('./labeler/label');

/**
 * Expose `Transitive`
 */

module.exports = Transitive;

/**
 * Expose `d3`
 */

module.exports.d3 = Transitive.prototype.d3 = d3;

/**
 * Expose `version`
 */

module.exports.version = '0.0.3';

/**
 * Create a new instance of `Transitive`
 *
 * @param {Object} options object
 *   - data {Object} data to render
 *   - drawGrid {Boolean} defaults to false
 *   - el {Element} element to render to
 *   - gridCellSize {Number} size of the grid
 *   - style {Object} styles to apply
 */

function Transitive(options) {
  if (!(this instanceof Transitive)) return new Transitive(options);
  if (options.el) this.setElement(options.el);

  this.clearFilters();
  this.data = options.data;
  this.baseGridCellSize = this.gridCellSize = options.gridCellSize || 500;
  this.labeler = new Labeler(this);
  this.options = options;
  this.paths = [];
  this.style = new Styler(options.styles);
}

/**
 * Mixin `Emitter`
 */

Emitter(Transitive.prototype);

/**
 * Add a data filter
 *
 * @param {String} type
 * @param {String|Object|Function} filter, gets passed to `to-function`
 */

Transitive.prototype.addFilter =
Transitive.prototype.filter = function(type, filter) {
  if (!this._filter[type]) this._filter[type] = [];
  this._filter[type].push(toFunction(filter));

  return this;
};

/**
 * Clear all data filters
 *
 * @param {String} filter type
 */

Transitive.prototype.clearFilters = function(type) {
  if (type) {
    this._filter[type] = [];
  } else {
    this._filter = {
      patterns: [],
      routes: [],
      stops: []
    };
  }

  this.emit('clear filters', this);
  return this;
};

/**
 * Load
 *
 * @param {Object} data
 */

Transitive.prototype.load = function(data) {
  debug('loading', data);

  // Store data
  this.data = data;

  // A list of points (stops & places) that will become vertices in the network graph. This
  // includes all stops that serve as a pattern endpoint and/or a
  // convergence/divergence point between patterns
  this.vertexPoints = [];

  // object maps stop ids to arrays of unique stop_ids reachable from that stop
  this.adjacentStops = {};

  // Generate the route objects
  this.routes = {};
  applyFilters(data.routes, this._filter.routes).forEach(function (data) {
    this.routes[data.route_id] = new Route(data);
  }, this);

  // Generate the stop objects
  this.stops = {};
  applyFilters(data.stops, this._filter.stops).forEach(function (data) {
    this.stops[data.stop_id] = new Stop(data);
  }, this);

  // Generate the pattern objects
  this.patterns = {};
  applyFilters(data.patterns, this._filter.patterns).forEach(function (data) {
    var pattern = new RoutePattern(data, this);
    this.patterns[data.pattern_id] = pattern;
    var route = this.routes[data.route_id];
    route.addPattern(pattern);
    pattern.route = route;
  }, this);

  // Generate the place objects
  this.places = {};
  data.places.forEach(function (data) {
    var place = this.places[data.place_id] = new Place(data, this);
    this.addVertexPoint(place);
  }, this);

  // Generate the routes & patterns
  /*this.routes = {};
  this.patterns = {};

  if(data.routes) {
    applyFilters(data.routes, this._filter.routes).forEach(function (routeData) {
      var route = this.routes[routeData.route_id] = new Route(routeData);
      // iterate through the Route's constituent Patterns
      applyFilters(routeData.patterns, this._filter.patterns).forEach(function (patternData, i) {
        var pattern = this.processStopSequence(patternData, patternData.pattern_id, vertexStops, adjacentStops);
        pattern.route = route;
      }, this);
    }, this);
  }*/

  // Generate the internal Journey objects
  this.journeys = {};
  if(data.journeys) {
    data.journeys.forEach((function(journeyData) {
      var journey = new Journey(journeyData, this);
      //var pattern = this.processStopSequence(journeyData, journeyData.journey_id, vertexStops, adjacentStops);
      //journey.addPattern(pattern);
      //journey.combinedPattern = pattern;
      this.journeys[journeyData.journey_id] = journey;
      this.paths.push(journey.path);

    }).bind(this));
  }

  // process the path segments
  for(var p = 0; p < this.paths.length; p++) {
    var path = this.paths[p];
    for(var s = 0; s < path.segments.length; s++) {
      this.processSegment(path.segments[s]);
    }
  }


  // determine the convergence/divergence vertex stops by looking for stops w/ >2 adjacent stops
  for (var stopId in this.adjacentStops) {
    if (this.adjacentStops[stopId].length > 2) {
      this.addVertexPoint(this.stops[stopId]);
    }
  }

  this.createGraph();
  this.setScale();

  this.loaded = true;
  this.emit('load', this);
  return this;
};


/** Graph Creation/Processing Methods **/


Transitive.prototype.createGraph = function() {

  this.graph = new Graph();

  // populate the vertices in the graph object
  for(var i = 0; i < this.vertexPoints.length; i++) {
    var point = this.vertexPoints[i];
    var vertex = this.graph.addVertex(point);
  }

  this.populateGraphEdges();

  this.processGraph();
};


Transitive.prototype.processGraph = function() {
  this.graph.collapseTransfers(this.gridCellSize / 2);
  this.annotateTransitPoints();
  this.populateRenderSegments();
  this.labeler.updateLabelList();
  this.updateGeometry(true);
};

Transitive.prototype.updateGeometry = function(snapGrid) {

  if(snapGrid) this.graph.snapToGrid(this.gridCellSize);

  // clear the stop render data
  for (var key in this.stops) this.stops[key].renderData = [];

  this.graph.vertices.forEach(function(vertex) {
    vertex.snapped = false;
    vertex.point.clearRenderData();
  });

  this.graph.calculateGeometry(this.gridCellSize);
  this.graph.optimizeCurvature();

  this.renderSegments.forEach(function(segment) {
    segment.clearOffsets();
  });
  this.graph.apply2DOffsets(this);

};

/**
 *
 */


Transitive.prototype.processSegment = function(segment) {

  // iterate through this pattern's stops, associating stops/patterns with
  // each other and initializing the adjacentStops table
  var previousStop = null;
  for(var i=0; i < segment.points.length; i++) {
    var point = segment.points[i];

    // called for each pair of adjacent stops in sequence
    if(previousStop && point.getType() === 'STOP') {
      this.addStopAdjacency(point.getId(), previousStop.getId());
      this.addStopAdjacency(previousStop.getId(), point.getId());
    }

    previousStop = (point.getType() === 'STOP') ? point : null;

    // add the start and end points to the vertexStops collection
    var startPoint = segment.points[0];
    this.addVertexPoint(startPoint);
    startPoint.isSegmentEndPoint = true;

    var endPoint = segment.points[segment.points.length-1];
    this.addVertexPoint(endPoint);
    endPoint.isSegmentEndPoint = true;

  }
};


/**
 * Helper function for stopAjacency table
 *
 * @param {Stop} adjacent stops list
 * @param {Stop} stopA
 * @param {Stop} stopB
 */

Transitive.prototype.addStopAdjacency = function(stopIdA, stopIdB) {
  if (!this.adjacentStops[stopIdA]) this.adjacentStops[stopIdA] = [];
  if (this.adjacentStops[stopIdA].indexOf(stopIdB) === -1) this.adjacentStops[stopIdA].push(stopIdB);
};


/**
 * Populate the graph edges
 *
 * @param {Object} patterns
 * @param {Graph} graph
 */

Transitive.prototype.populateGraphEdges = function() {
  // vertex associated with the last vertex point we passed in this sequence
  var lastVertex = null;

  // collection of 'internal' (i.e. non-vertex) points passed
  // since the last vertex point
  var internalPoints = [];

  for(var p = 0; p < this.paths.length; p++) {
    var path = this.paths[p];
    for(var s = 0; s < path.segments.length; s++) {
      var segment = path.segments[s];

      lastVertex = null;
      var lastVertexIndex = 0;

      for(var i=0; i< segment.points.length; i++) {
        var point = segment.points[i];
        if (point.graphVertex) { // this is a vertex point
          if (lastVertex !== null) {
            var edge = this.graph.getEquivalentEdge(internalPoints, lastVertex,
              point.graphVertex);

            if (!edge) {
              edge = this.graph.addEdge(internalPoints, lastVertex, point.graphVertex);

              // calculate the angle and apply to edge stops
              var dx = point.graphVertex.x - lastVertex.x;
              var dy = point.graphVertex.y - lastVertex.y;
              var angle = Math.atan2(dy, dx) * 180 / Math.PI;
              point.angle = lastVertex.point.angle = angle;
              for(var is = 0; is < internalPoints.length; is++) {
                internalPoints[is].angle = angle;
              }
            }

            path.addEdge(edge);
            segment.graphEdges.push(edge);
            edge.addPath(path);
            edge.addPathSegment(segment);

          }

          lastVertex = point.graphVertex;
          lastVertexIndex = i;
          internalPoints = [];
        } else { // this is an internal point
          internalPoints.push(point);
        }
      }
    }
  }
};


Transitive.prototype.annotateTransitPoints = function() {
  var lookup = {};
  this.renderSegments = [];

  this.paths.forEach(function(path) {

    var transitSegments = [];
    path.segments.forEach(function(pathSegment) {
      if(pathSegment.type === 'TRANSIT') transitSegments.push(pathSegment);
    });

    path.segments.forEach(function(pathSegment) {
      if(pathSegment.type === 'TRANSIT') {

        // if first transit segment in path, mark 'from' endpoint as board point
        if(transitSegments.indexOf(pathSegment) === 0) {
          pathSegment.points[0].isBoardPoint = true;

          // if there are additional transit segments, mark the 'to' endpoint as a transfer point
          if(transitSegments.length > 1) pathSegment.points[pathSegment.points.length-1].isTransferPoint = true;
        }

        // if last transit segment in path, mark 'to' endpoint as alight point
        else if(transitSegments.indexOf(pathSegment) === transitSegments.length-1) {
          pathSegment.points[pathSegment.points.length-1].isAlightPoint = true;

          // if there are additional transit segments, mark the 'from' endpoint as a transfer point
          if(transitSegments.length > 1) pathSegment.points[0].isTransferPoint = true;
        }

        // if this is an 'internal' transit segment, mark both endpoints as transfer points
        else if(transitSegments.length > 2) {
          pathSegment.points[0].isTransferPoint = true;
          pathSegment.points[pathSegment.points.length-1].isTransferPoint = true;
        }

      }
    });
  });
};


Transitive.prototype.populateRenderSegments = function() {
  var lookup = {};
  this.renderSegments = [];

  this.paths.forEach(function(path) {

    path.segments.forEach(function(pathSegment) {

      pathSegment.renderSegments = [];
      pathSegment.graphEdges.forEach(function(edge) {
        var renderSegment;
        var key = edge.id + '_' + pathSegment.getType() + (pathSegment.pattern ? '_' + pathSegment.pattern.pattern_id : '');
        if(key in lookup) {
          renderSegment = lookup[key];
        }
        else {
          renderSegment = new Segment(pathSegment.type);
          renderSegment.pattern = pathSegment.pattern;
          renderSegment.addEdge(edge);
          renderSegment.points.push(edge.fromVertex.point);
          renderSegment.points.push(edge.toVertex.point);
          edge.addRenderSegment(renderSegment);

          this.renderSegments.push(renderSegment);
          lookup[key] = renderSegment;
        }
        pathSegment.renderSegments.push(renderSegment);
      }, this);
    }, this);
  }, this);
};



Transitive.prototype.addVertexPoint = function(point) {
  if(this.vertexPoints.indexOf(point) !== -1) return;
  this.vertexPoints.push(point);
};


/** Display/Render Methods **/


/**
 * Set the DOM element that serves as the main map canvas
 */

Transitive.prototype.setElement = function(el) {
  if (this.el) this.el.innerHTML = null;

  this.el = el;
  this.initializeDisplay();

  this.setScale();
  this.lastScale = this.display.zoom.scale();

  this.emit('set element', this, this.el);
  return this;
};


/**
 * Create the Display object and set up the pan/zoom functionality
 */

Transitive.prototype.initializeDisplay = function() {
  var self = this;
  this.display = new Display(this.el);
  this.display.zoom.on('zoom', function() {
    var scale = self.display.zoom.scale();
    if (scale !== self.lastScale) {
      self.lastScale = scale;
      self.gridCellSize = self.baseGridCellSize * (1 / scale);

      self.paths.forEach(function(path) {
        path.clearGraphData();
      });

      self.createGraph();
      self.render();
    } else {
      self.refresh();
    }
  });

  this.emit('initialize display', this, this.display);
  return this;
};


/**
 * Set scale
 */

Transitive.prototype.setScale = function() {
  if (this.display && this.el && this.graph) {
    this.display.setScale(this.el.clientHeight, this.el.clientWidth,
      this.graph);
  }

  this.emit('set scale', this);
  return this;
};


/**
 * Render
 */

Transitive.prototype.render = function() {

  if(!this.loaded) {
    this.load(this.data);
  }

  //var display = this.display;
  this.display.styler = this.style;

  var offsetLeft = this.el.offsetLeft;
  var offsetTop = this.el.offsetTop;

  // remove all old svg elements
  this.display.empty();

  // draw the path highlights
  for(var p = 0; p < this.paths.length; p++) {
    this.paths[p].drawHighlight(this.display);
  }

  // draw the segments
  for(var s = 0; s < this.renderSegments.length; s++) {
    var segment = this.renderSegments[s];
    //console.log(segment);
    segment.refreshRenderData(true, this.style, this.display);
    segment.draw(this.display, 0); // 10);
  }

  // draw the vertex-based points
  this.graph.vertices.forEach(function(vertex) {
    vertex.point.render(this.display);
  }, this);

  // draw the edge-based points
  this.graph.edges.forEach(function(edge) {
    edge.pointArray.forEach(function(point) {
      point.render(this.display);
    }, this);
  }, this);


  this.refresh();

  this.emit('render', this);
  return this;
};

/**
 * Render to
 *
 * @param {Element} el
 */

Transitive.prototype.renderTo = function(el) {
  this.setElement(el);
  this.render();

  this.emit('render to', this);
  return this;
};

/**
 * Refresh
 */

Transitive.prototype.refresh = function() {

  this.graph.vertices.forEach(function(vertex) {
    vertex.point.clearRenderData();
  });

  // draw the grid, if necessary
  if(this.options.drawGrid) this.display.drawGrid(this.gridCellSize);

  // refresh the segments
  for(var s = 0; s < this.renderSegments.length; s++) {
    var segment = this.renderSegments[s];
    segment.refreshRenderData(true, this.style, this.display);
    segment.refresh(this.display);
  }

  // refresh the path highlights
  for(var p = 0; p < this.paths.length; p++) {
    this.paths[p].refreshHighlight(this.display);
  }


  // refresh the vertex-based points
  this.graph.vertices.forEach(function(vertex) {
    var point = vertex.point;
    if (!point.svgGroup) return; // check if this point is not currently rendered
    this.style.renderPoint(this.display, point);
    point.refresh(this.display);
  }, this);

  // refresh the edge-based points
  this.graph.edges.forEach(function(edge) {
    edge.pointArray.forEach(function(point) {
      if (!point.svgGroup) return; // check if this point is not currently rendered
      this.style.renderStop(this.display, point);
      point.refresh(this.display);
    }, this);
  }, this);

  // refresh the label layout
  var labeledElements = this.labeler.doLayout();
  labeledElements.points.forEach(function(point) {
    point.refreshLabel(this.display);
    this.style.renderPointLabel(this.display, point);
  }, this);
  labeledElements.segments.forEach(function(segment) {
    segment.refreshLabel(this.display);
    this.style.renderSegmentLabel(this.display, segment);
  }, this);

  this.sortElements();

  this.emit('refresh', this);
  return this;
};


Transitive.prototype.sortElements = function(journeyId) {

  this.renderSegments.sort(function(a, b) {
    if(a.isFocused() && !b.isFocused()) return 1;
    if(b.isFocused() && !a.isFocused()) return -1;
    return(a.compareTo(b));
  });

  this.renderSegments.forEach(function(segment, index) {
    segment.zIndex = index * 10;
  });

  this.display.svg.selectAll('.transitive-sortable').sort(function(a, b) {
    //console.log(a.owner);
    var aIndex = (typeof a.getZIndex === 'function') ? a.getZIndex() : a.owner.getZIndex();
    var bIndex = (typeof b.getZIndex === 'function') ? b.getZIndex() : b.owner.getZIndex();
    //if(a.console.log(aIndex);
    return aIndex - bIndex;
  });
};


Transitive.prototype.focusJourney = function(journeyId) {
  var journeyRenderSegments = [];

  if(journeyId) {
    var journey = this.journeys[journeyId];
    journeyRenderSegments = journey.path.getRenderSegments();

    this.graph.edges.forEach(function(edge) {
      edge.pointArray.forEach(function (point, i) {
        point.setAllPatternsFocused(false);
      });
    }, this);
  }
  else {
    this.graph.edges.forEach(function(edge) {
      edge.pointArray.forEach(function (point, i) {
        point.setAllPatternsFocused(true);
      });
    }, this);
  }

  var focusedVertexPoints = [];
  //var focusedInternalPoints = [];
  this.renderSegments.forEach(function(segment) {
    if(journeyId && journeyRenderSegments.indexOf(segment) === -1) {
      segment.setFocused(false);
    }
    else {
      segment.setFocused(true);
      segment.graphEdges.forEach(function(edge, edgeIndex) {
        focusedVertexPoints.push(edge.fromVertex.point);
        focusedVertexPoints.push(edge.toVertex.point);
        edge.pointArray.forEach(function (point, i) {
          point.setPatternFocused(segment.pattern.getId(), true);
        });
      });

    }
  });

  this.graph.vertices.forEach(function(vertex) {
    var point = vertex.point;
    point.setFocused(focusedVertexPoints.indexOf(point) !== -1);
  }, this);

  this.refresh();
};


Transitive.prototype.offsetSegment = function(segment, axisId, offset) {
  if(segment.pattern) {
    this.renderSegments.forEach(function(rseg) {
      if(rseg.pattern && rseg.pattern.pattern_id === segment.pattern.pattern_id) {
        rseg.offsetAxis(axisId, offset);
      }
    });
  }
  else segment.offsetAxis(axisId, offset);
};

/**
 * Apply an array of filters to an array of data
 *
 * @param {Array} data
 * @param {Array} filters
 */

function applyFilters(data, filters) {
  filters.forEach(function (filter) {
    data = data.filter(filter);
  });

  return data;
}