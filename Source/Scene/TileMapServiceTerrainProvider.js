/*global define*/
define([
        '../Core/defaultValue',
        '../Core/jsonp',
        '../Core/loadImage',
        '../Core/getImagePixels',
        '../Core/writeTextToCanvas',
        '../Core/DeveloperError',
        '../Core/Math',
        '../Core/BoundingSphere',
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Cartographic',
        '../Core/Extent',
        '../Core/Occluder',
        '../Core/TaskProcessor',
        './Projections',
        './TileState',
        './TerrainProvider',
        './GeographicTilingScheme',
        './WebMercatorTilingScheme',
        '../ThirdParty/when'
    ], function(
        defaultValue,
        jsonp,
        loadImage,
        getImagePixels,
        writeTextToCanvas,
        DeveloperError,
        CesiumMath,
        BoundingSphere,
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Cartographic,
        Extent,
        Occluder,
        TaskProcessor,
        Projections,
        TileState,
        TerrainProvider,
        GeographicTilingScheme,
        WebMercatorTilingScheme,
        when) {
    "use strict";

    /**
     * A {@link TerrainProvider} that produces geometry by tessellating height maps
     * retrieved from a Tile Map Service (TMS) server.
     *
     * @alias TileMapServiceTerrainProvider
     * @constructor
     *
     * @param {String} description.url The URL of the TMS service.
     * @param {Object} [description.proxy] A proxy to use for requests. This object is expected to have a getURL function which returns the proxied URL, if needed.
     *
     * @see TerrainProvider
     */
    function TileMapServiceTerrainProvider(description) {
        description = defaultValue(description, {});

        if (typeof description.url === 'undefined') {
            throw new DeveloperError('description.url is required.');
        }

        /**
         * The URL of the ArcGIS ImageServer.
         * @type {String}
         */
        this.url = description.url;

        /**
         * The tiling scheme used to tile the surface.
         *
         * @type TilingScheme
         */
        this.tilingScheme = new GeographicTilingScheme({
            numberOfLevelZeroTilesX : 2,
            numberOfLevelZeroTilesY : 1
        });
        this.maxFileLevel = 11;
        this.heightmapWidth = 32;
        this.levelZeroMaximumGeometricError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(this.tilingScheme.getEllipsoid(), this.heightmapWidth, this.tilingScheme.getNumberOfXTilesAtLevel(0));

        this._proxy = description.proxy;

        this.ready = true;
    }

    /**
     * Gets the maximum geometric error allowed in a tile at a given level.
     *
     * @param {Number} level The tile level for which to get the maximum geometric error.
     * @returns {Number} The maximum geometric error.
     */
    TileMapServiceTerrainProvider.prototype.getLevelMaximumGeometricError = TerrainProvider.prototype.getLevelMaximumGeometricError;

    var requestsInFlight = 0;
    // Creating the geometry will require a request to the ImageServer, which will complete
    // asynchronously.  The question is, what do we do in the meantime?  The best thing to do is
    // to use terrain associated with the parent tile.  Ideally, we would be able to render
    // high-res imagery attached to low-res terrain.  In some ways, this is similar to the need
    // described in TerrainProvider of creating geometry for tiles at a higher level than
    // the terrain source actually provides.

    // In the short term, for simplicity:
    // 1. If a tile has geometry available but it has not yet been loaded, don't render the tile until
    //    the geometry has been loaded.
    // 2. If a tile does not have geometry available at all, do not render it or its siblings.
    // Longer term, #1 may be acceptable, but #2 won't be for the reasons described above.
    // To address #2, we can subdivide a mesh into its four children.  This will be fairly CPU
    // intensive, though, which is why we probably won't want to do it while waiting for the
    // actual data to load.  We could also potentially add fractal detail when subdividing.

    /**
     * Request the tile geometry from the remote server.  Once complete, the
     * tile state should be set to RECEIVED.  Alternatively, tile state can be set to
     * UNLOADED to indicate that the request should be attempted again next update, if the tile
     * is still needed.
     *
     * @param {Tile} The tile to request geometry for.
     */
    TileMapServiceTerrainProvider.prototype.requestTileGeometry = function(tile) {
        var that = this;
        function success(image) {
            --requestsInFlight;
            tile.geometry = getImagePixels(image);
            tile.hasRealData = true;
            tile.state = TileState.RECEIVED;
        }

        function failure(e) {
            // Tile failed to load, so upsample from the parent tile.
            --requestsInFlight;

            // Find the nearest ancestor with data.
            var levelDifference = 1;
            var sourceTile = tile.parent;
            while (typeof sourceTile !== 'undefined' && !sourceTile.hasRealData) {
                sourceTile = sourceTile.parent;
                ++levelDifference;
            }

            if (typeof sourceTile === 'undefined') {
                tile.state = TileState.FAILED;
                return;
            }

            var width = that.heightmapWidth;
            var height = width;
            var stride = 4;
            var destinationExtent = tile.extent;
            var sourceExtent = sourceTile.extent;

            var buffer = new ArrayBuffer(width * height * stride);
            var heights = new Uint8Array(buffer, 0, width * height * stride);
            var sourceHeights = sourceTile.geometry;

            function triangleInterpolateHeight(dX, dY, southwestHeight, southeastHeight, northwestHeight, northeastHeight) {
                // The HeightmapTessellator bisects the quad from southwest to northeast.
                if (dY < dX) {
                    // Lower right triangle
                    return southwestHeight + (dX * (southeastHeight - southwestHeight)) + (dY * (northeastHeight - southeastHeight));
                }

                // Upper left triangle
                return southwestHeight + (dX * (northeastHeight - northwestHeight)) + (dY * (northwestHeight - southwestHeight));
            }

            function getHeight(heights, index) {
                index *= 4;
                return (heights[index] << 16) |
                       (heights[index + 1] << 8) |
                       heights[index + 1];
            }

            function setHeight(heights, index, height) {
                index *= 4;
                heights[index] = height >> 16;
                heights[index + 1] = (height >> 8) & 0xFF;
                heights[index + 2] = height & 0xFF;
            }

            function interpolateHeight(sourceHeights, sourceExtent, longitude, latitude) {
                var fromWest = (longitude - sourceExtent.west) * 31 / (sourceExtent.east - sourceExtent.west);
                var fromSouth = (latitude - sourceExtent.south) * 31 / (sourceExtent.north - sourceExtent.south);

                var westInteger = fromWest | 0;
                var eastInteger = westInteger + 1;
                if (eastInteger >= 32) {
                    eastInteger = 31;
                    westInteger = 30;
                }

                var southInteger = fromSouth | 0;
                var northInteger = southInteger + 1;
                if (northInteger >= 32) {
                    northInteger = 31;
                    southInteger = 30;
                }

                var dx = fromWest - westInteger;
                var dy = fromSouth - southInteger;

                southInteger = 31 - southInteger;
                northInteger = 31 - northInteger;

                var southwestHeight = getHeight(sourceHeights, southInteger * 32 + westInteger);
                var southeastHeight = getHeight(sourceHeights, southInteger * 32 + eastInteger);
                var northwestHeight = getHeight(sourceHeights, northInteger * 32 + westInteger);
                var northeastHeight = getHeight(sourceHeights, northInteger * 32 + eastInteger);

                return triangleInterpolateHeight(dx, dy, southwestHeight, southeastHeight, northwestHeight, northeastHeight);
            }

            for (var j = 0; j < height; ++j) {
                var latitude = CesiumMath.lerp(destinationExtent.north, destinationExtent.south, j / (height - 1));
                for (var i = 0; i < width; ++i) {
                    var longitude = CesiumMath.lerp(destinationExtent.west, destinationExtent.east, i / (width - 1));
                    setHeight(heights, j * width + i, interpolateHeight(sourceHeights, sourceExtent, longitude, latitude));
                }
            }

            tile.geometry = heights;

            tile.state = TileState.RECEIVED;
        }

        if (tile.level > this.maxFileLevel) {
            failure();
        } else {
            if (requestsInFlight > 6) {
                tile.state = TileState.UNLOADED;
                return;
            }

            ++requestsInFlight;

            var yTiles = this.tilingScheme.getNumberOfYTilesAtLevel(tile.level);

            var url = this.url + '/' + tile.level + '/' + tile.x + '/' + (yTiles - tile.y - 1) + '.png';

            if (typeof this._proxy !== 'undefined') {
                url = this._proxy.getURL(url);
            }

            when(loadImage(url, true), success, failure);
        }
    };

    var taskProcessor = new TaskProcessor('createVerticesFromHeightmap');

    /**
     * Transform the tile geometry from the format requested from the remote server
     * into a format suitable for resource creation.  Once complete, the tile
     * state should be set to TRANSFORMED.  Alternatively, tile state can be set to
     * RECEIVED to indicate that the transformation should be attempted again next update, if the tile
     * is still needed.
     *
     * @param {Context} context The context to use to create resources.
     * @param {Tile} tile The tile to transform geometry for.
     */
    TileMapServiceTerrainProvider.prototype.transformGeometry = function(context, tile) {
        // Get the height data from the image by copying it to a canvas.
        var width = 32;
        var height = 32;
        var pixels = tile.geometry;

        var tilingScheme = this.tilingScheme;
        var ellipsoid = tilingScheme.getEllipsoid();
        var extent = tilingScheme.tileXYToNativeExtent(tile.x, tile.y, tile.level);

        tile.center = ellipsoid.cartographicToCartesian(tile.extent.getCenter());

        var verticesPromise = taskProcessor.scheduleTask({
            heightmap : pixels,
            heightScale : 1000.0,
            heightOffset : 1000.0,
            bytesPerHeight : 3,
            stride : 4,
            width : width,
            height : height,
            extent : extent,
            relativeToCenter : tile.center,
            radiiSquared : ellipsoid.getRadiiSquared(),
            oneOverCentralBodySemimajorAxis : ellipsoid.getOneOverRadii().x,
            skirtHeight : Math.min(this.getLevelMaximumGeometricError(tile.level) * 10.0, 1000.0),
            isGeographic : true
        });

        if (typeof verticesPromise === 'undefined') {
            //postponed
            tile.state = TileState.RECEIVED;
            return;
        }

        when(verticesPromise, function(result) {
            tile.transformedGeometry = {
                vertices : result.vertices,
                statistics : result.statistics,
                indices : TerrainProvider.getRegularGridIndices(width + 2, height + 2)
            };
            tile.state = TileState.TRANSFORMED;
        }, function(e) {
            /*global console*/
            console.error('failed to transform geometry: ' + e);
            tile.state = TileState.FAILED;
        });
    };

    var scratch = new Cartesian3();

    /**
     * Create WebGL resources for the tile using whatever data the transformGeometry step produced.
     * Once complete, the tile state should be set to READY.  Alternatively, tile state can be set to
     * TRANSFORMED to indicate that resource creation should be attempted again next update, if the tile
     * is still needed.
     *
     * @param {Context} context The context to use to create resources.
     * @param {Tile} tile The tile to create resources for.
     */
    TileMapServiceTerrainProvider.prototype.createResources = function(context, tile) {
        var buffers = tile.transformedGeometry;
        tile.transformedGeometry = undefined;

        TerrainProvider.createTileEllipsoidGeometryFromBuffers(context, tile, buffers);
        tile.maxHeight = buffers.statistics.maxHeight;
        tile.boundingSphere3D = BoundingSphere.fromVertices(buffers.vertices, tile.center, 5);

        var ellipsoid = this.tilingScheme.getEllipsoid();
        var extent = tile.extent;
        tile.southwestCornerCartesian = ellipsoid.cartographicToCartesian(extent.getSouthwest());
        tile.southeastCornerCartesian = ellipsoid.cartographicToCartesian(extent.getSoutheast());
        tile.northeastCornerCartesian = ellipsoid.cartographicToCartesian(extent.getNortheast());
        tile.northwestCornerCartesian = ellipsoid.cartographicToCartesian(extent.getNorthwest());

        tile.westNormal = Cartesian3.UNIT_Z.cross(tile.southwestCornerCartesian.negate(scratch), scratch).normalize();
        tile.eastNormal = tile.northeastCornerCartesian.negate(scratch).cross(Cartesian3.UNIT_Z, scratch).normalize();
        tile.southNormal = ellipsoid.geodeticSurfaceNormal(tile.southeastCornerCartesian).cross(tile.southwestCornerCartesian.subtract(tile.southeastCornerCartesian, scratch)).normalize();
        tile.northNormal = ellipsoid.geodeticSurfaceNormal(tile.northwestCornerCartesian).cross(tile.northeastCornerCartesian.subtract(tile.northwestCornerCartesian, scratch)).normalize();

        // TODO: we need to take the heights into account when computing the occludee point.
        var occludeePoint = Occluder.computeOccludeePointFromExtent(tile.extent, ellipsoid);
        if (typeof occludeePoint !== 'undefined') {
            Cartesian3.multiplyComponents(occludeePoint, ellipsoid.getOneOverRadii(), occludeePoint);
        }
        tile.occludeePointInScaledSpace = occludeePoint;

        tile.state = TileState.READY;
    };

    /**
     * DOC_TBA
     * @memberof ArcGisImageServerTerrainProvider
     */
    TileMapServiceTerrainProvider.prototype.getLogo = function() {
        return this._logo;
    };

    return TileMapServiceTerrainProvider;
});