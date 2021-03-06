/* jshint node: true */
'use strict';
/*
	✔︎ DELETE /items/{id}
	✔︎ GET /items
	✔︎ GET /items/{id}
	✔︎ POST /items
	✔︎ PUT /items (optional)
	✔︎ PUT /items/{id}
	✔︎ POST /items/{id} (optional)

	TODO: https://github.com/mgonto/restangular
*/
var debug = require('debug')('meanify');
var mongoose = require('mongoose');
var pluralize = require('pluralize');

// mongoose.set('debug', true);

function Meanify(Model, options) {

	console.log('*********** INIT ************');

	if (typeof Model === 'string') {
		Model = mongoose.model(Model);
	}

	var modelName = Model.modelName;
	var meanify = this;

	// Find geospatial index for geo queries.
	// http://docs.mongodb.org/manual/reference/operator/query/nearSphere/
	// https://github.com/LearnBoost/mongoose/wiki/3.6-Release-Notes#geojson-support-mongodb--24
	var indexes = Model.schema._indexes;
	var geoField;
	if (indexes) {
		indexes.forEach(function (indexes) {
			indexes.forEach(function (index) {
				for (var x in index) {
					if (index[x] === '2dsphere') {
						geoField = x;
						break;
					}
				}
			});
		});
	}

	// Enable relationship support on create/delete.
	if (options.relate) {
		var relationships = [];
		// TODO: Model.tree?
		var tree = Model.base.modelSchemas[modelName].tree;
		for (var property in tree) {

			// Alternative way of specifying Geospatial index.
			// https://github.com/LearnBoost/mongoose/wiki/3.6-Release-Notes#geojson-support-mongodb--24
			if (tree[property].index === '2dsphere') {
				geoField = property;
			}

			var schema = tree[property];
			if (Array.isArray(schema)) {
				schema = schema[0];
			}

			if (schema.ref) {
				var relatedModel = mongoose.model(schema.ref);
				// TODO: relatedModel.tree?
				var relatedTree = relatedModel.base.modelSchemas[schema.ref].tree;
				for (var relatedProperty in relatedTree) {

					var isArray = false;
					var relatedSchema = relatedTree[relatedProperty];
					if (Array.isArray(relatedSchema)) {
						isArray = true;
						relatedSchema = relatedSchema[0];
					}

					if (relatedSchema.ref === modelName) {
						// debug('Found related property: ', y);
						relationships.push({
							isArray: isArray,
							Model: Model,
							property: property,
							relatedModel: relatedModel,
							relatedProperty: relatedProperty
						});
					}
				}
			}
		}
	}

	meanify.search = function search(req, res, next) {
		console.log('/****************** Got in search **************');
		// TODO: Use Model.schema.paths to check/cast types.
		var fields = req.query;
		var params = {};

		// Normalize count parameter.
		if (fields.hasOwnProperty('__count')) {
			fields.__count = true;
		}

		['count', 'populate', 'sort', 'skip', 'limit', 'near'].forEach(function (param) {
			params[param] = fields['__' + param];
			delete fields['__' + param];
		});

		if (params.near) {

			if (!geoField) {
				return next({
					'error': 'Geospatial Index Not Found',
					'message': 'http://docs.mongodb.org/manual/reference/operator/query/nearSphere/ --> The $nearSphere operator requires a geospatial index and can use either 2dsphere index or 2d index for location data defined as GeoJSON points or legacy coordinate pairs. To use a 2d index on GeoJSON points, create the index on the coordinates field of the GeoJSON object. To set index in Mongoose: // https://github.com/LearnBoost/mongoose/wiki/3.6-Release-Notes#geojson-support-mongodb--24'
				});
			}

			var coordinates = params.near.split(',')
				.map(function (item) {
					return parseFloat(item);
				});

			fields[geoField] = {
				$nearSphere: {
					$geometry: {
						type: 'Point',
						coordinates: coordinates
					}
				}
			};

			// Set max distance (meters) if supplied.
			if (coordinates.length === 3) {
				fields[geoField].$nearSphere.$maxDistance = coordinates.pop();
			}

		}

		// Support JSON objects for range queries, etc.
		var objRegex = /^{.*}$/;
		for (var field in fields) {
			var value = fields[field];
			if (objRegex.test(value)) {
				fields[field] = JSON.parse(value);
			}
		}

		var query = Model.find(fields);

		console.log('********************* STARTED QUERY *******************');

		if (params.count) {

			console.log('********************* PARAMS COUNT *******************');
			query.count(function (err, data) {
				if (err) {
					debug('Search middleware query.count error:', err);
					return next(err);
				}
				return res.send([data]);
			});
		} else {
			if (params.limit) {
				query.limit(params.limit);
			}
			if (params.skip) {
				query.skip(params.skip);
			}
			if (params.sort) {
				query.sort(params.sort);
			}
			if (params.populate) {
				query.populate(params.populate);
			}

			console.log('********************* BEFORE EXECUTE *******************');
			query.exec(function (err, data) {
				if (err) {
					debug('Search middleware query error:', err);
					return next(err);
				}
				console.log('********************** EXECUTED ******************');
				return res.json(data);
				next();
			});
		}
	};

	meanify.create = function create(req, res) {

		Model.create(req.body, function (err, data) {
			if (err) {
				return res.status(400).send(err);
			}

			// Populate relationships.
			if (options.relate) {
				// TODO: Finish relationships before sending response.
				relationships.forEach(function (relation) {

					var referenceId = data[relation.property];
					// Normalize to array.
					if (!Array.isArray(referenceId)) {
						referenceId = [ referenceId ];
					}

					referenceId.forEach(function (id) {
						var update = {};
						update[relation.relatedProperty] = data._id;
						relation.relatedModel.findByIdAndUpdate(id,
							relation.isArray ? { $addToSet: update } : update,
							function (err, data) {
								if (err) {
									debug('Relationship error:', err);
									debug('Failed to relate:',
										relation.relatedModel.modelName,
										relation.relatedProperty);
								}
								debug('Relationship success:', data);
							}
						);
					});

				});
			}

			return res.status(201).send(data);
		});
	};

	meanify.update = function update(req, res, next) {
		var id = req.params.id;
		Model.findById(id, function (err, data) {
			if (err) {
				debug('Update middleware Model.findById error:', err);
				return next(err);
			}
			if (data) {
				// Update using simple extend.
				for (var property in req.body) {
					data[property] = req.body[property];
				}
				data.save(function (err) {
					if (err) {
						return res.status(400).send(err);
					}
					return res.status(204).send();
				});
			} else {
				return res.status(404).send();
			}
		});
	};

	// Instance Methods
	function instanceMethod(method) {
		return function (req, res, next) {
			var id = req.params.id;
			if (id) {
				Model.findById(id, function (err, data) {
					if (err) {
						debug('Method middleware Model.findById error:', err);
						return next(err);
					}
					if (data) {
						data[method](req, res, function (err, data) {
							if (err) {
								return res.status(400).send(err);
							}
							return res.send(data);
						});
					} else {
						return res.status(404).send();
					}
				});
			} else {
				return res.status(404).send();
			}
		};
	}
	var methods = Model.schema.methods;
	for (var method in methods) {
		meanify.update[method] = instanceMethod(method);
	}

	meanify.delete = function del(req, res, next) {
		var id = req.params.id;
		if (id) {
			Model.findByIdAndRemove(id, function (err, data) {
				if (err) {
					debug('Delete middleware Model.findByIdAndRemove error:', err);
					return next(err);
				}

				// Remove relationships.
				if (options.relate && data) {
					debug('Deleting:', data);
					// TODO: Finish deleting relationships before sending response.
					relationships.forEach(function (relation) {

						var referenceId = data[relation.property];
						// Normalize to array.
						if (!Array.isArray(referenceId)) {
							referenceId = [ referenceId ];
						}

						referenceId.forEach(function (id) {
							var update = {};
							update[relation.relatedProperty] = data._id;
							relation.relatedModel.findByIdAndUpdate(id,
								relation.isArray ? { $pull: update } : { $unset: update },
								function (err, data) {
									if (err) {
										debug('Relationship delete error:', err);
										debug('Failed to delete relation:',
											relation.relatedModel.modelName + '.' +
											relation.relatedProperty);
									}
									debug('Relationship delete success:', data);
								}
							);
						});

					});
				}

				if (data) {
					return res.status(204).send();
				} else {
					return res.status(404).send();
				}

			});

		} else {
			return res.status(404).send();
		}
	};

	meanify.read = function (req, res, next) {

		var populate = '';
		if (req.query.__populate) {
			populate = req.query.__populate;
			delete req.query.__populate;
		}

		var id = req.params.id;
		if (id) {
			Model.findById(id)
				.populate(populate)
				.exec(function (err, data) {
				if (err) {
					debug('Read middleware Model.findById error:', err);
					return next(err);
				}
				if (data) {
					return res.send(data);
				} else {
					return res.status(404).send();
				}
			});
		} else {
			return res.status(404).send();
		}
	};

	function subdoc(field) {
		return {
			search: function (req, res, next) {
				var id = req.params.id;
				if (id) {
					Model.findById(id, function (err, parent) {
						if (err) {
							debug('Sub-document search middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (parent) {
							// TODO: Research available advanced query options.
							// http://docs.mongodb.org/manual/tutorial/query-documents/#embedded-documents
							return res.send(parent[field]);
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			create: function (req, res, next) {
				var id = req.params.id;
				if (id) {
					Model.findById(id, function (err, parent) {
						if (err) {
							debug('Sub-document create middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (parent) {
							var index = parent[field].push(req.body) - 1;
							var child = parent[field][index];
							parent.save(function (err) {
								if (err) {
									return res.status(400).send(err);
								}
								return res.status(201).send(child);
							});
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			read: function (req, res, next) {
				var id = req.params.id;
				var subId = req.params[field + 'Id'];
				if (id) {
					Model.findById(id, function (err, parent) {
						if (err) {
							debug('Sub-document read middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (parent) {
							var child = parent[field].id(subId);
							if (child) {
								return res.send(child);
							} else {
								return res.status(404).send();
							}
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			update: function (req, res, next) {
				var id = req.params.id;
				var subId = req.params[field + 'Id'];
				if (id) {
					Model.findById(id, function (err, parent) {
						if (err) {
							debug('Sub-document update middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (parent) {
							var child = parent[field].id(subId);
							if (child) {
								// Update using simple extend.
								for (var property in req.body) {
									child[property] = req.body[property];
								}
								parent.save(function (err) {
									if (err) {
										return res.status(400).send(err);
									}
									return res.status(200).send(child);
								});
							} else {
								return res.status(404).send();
							}
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			delete: function (req, res, next) {
				var id = req.params.id;
				var subId = req.params[field + 'Id'];
				if (id) {
					Model.findById(id, function (err, parent) {
						if (err) {
							debug('Sub-document delete middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (parent) {
							parent[field].id(subId).remove();
							parent.save(function (err) {
								if (err) {
									return res.status(400).send(err);
								}
								return res.status(204).send();
							});
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			}
		};
	}

	function refDoc(field) {
		var RefModel = mongoose.model(field);
		field.toLowerCase();
		if (options.pluralize) {
			field = pluralize(field);
		}

		return {
			search: function (req, res, next) {
				var subId = req.params[field + 'Id'];
				if (subId) {
					RefModel.find({id: subId, modelName: req.params.id}, function (err, data) {
						if (err) {
							debug('Reference-document search middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (data) {
							// TODO: Research available advanced query options.
							return res.send(data);
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			create: function (req, res, next) {
				if (req.body) {
					req.body[modelName] = req.params.id;
					RefModel.create(req.body, function (err, data) {
						if (err) {
							debug('Reference-document create middleware (' + field + ') Model.findById error:', err);
							return res.status(400).send(err);
						}
						return res.status(201).send(data);
					});
				} else {
					return res.status(404).send();
				}
			},
			read: function (req, res, next) {
				var subId = req.params[field + 'Id'];
				if (subId) {
					RefModel.findById(subId, function (err, data) {
						if (err) {
							debug('Reference-document read middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (data) {
							return res.send(data);
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			update: function (req, res, next) {
				var subId = req.params[field + 'Id'];
				if (subId) {
					RefModel.findById(subId, function (err, data) {
						if (err) {
							debug('Reference-document update middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}
						if (data) {
							// Update using simple extend.
							for (var property in req.body) {
								data[property] = req.body[property];
							}
							data.save(function (err) {
								if (err) {
									return res.status(400).send(err);
								}
								return res.status(200).send(child);
							});
						} else {
							return res.status(404).send();
						}
					});
				} else {
					return res.status(404).send();
				}
			},
			delete: function (req, res, next) {
				var id = req.params.id;
				var subId = req.params[field + 'Id'];
				if (subId) {
					RefModel.findByIdAndRemove(id, function (err, data) {
						if (err) {
							debug('Reference-document delete middleware (' + field + ') Model.findById error:', err);
							return next(err);
						}

						if (id) {
							Model.findById(id, function (err, parent) {
								if (err) {
									debug('Reference-document delete middleware (' + field + ') Model.findById error:', err);
									return next(err);
								}
								if (parent) {
									parent[field].remove();
									parent.save(function (err) {
										if (err) {
											return res.status(400).send(err);
										}
										return res.status(204).send();
									});
								} else {
									return res.status(404).send();
								}
							});
						}
					});
				} else {
					return res.status(404).send();
				}
			}
		};
	}

	var paths = Model.schema.paths;
	for (var field in paths) {
		var path = paths[field];
		if (path.caster && path.caster.options && path.caster.options.ref) {
			field = path.caster.options.ref;
			meanify[field] = refDoc(field);
		}
		if (path.schema) {
			meanify[field] = subdoc(field);
		}
	}
}

module.exports = function (options) {

	options = options || {};

	console.log(options.middleware);
	
	var express;
	var restify;
	var router;
	var parser;
	var middleware = options.middleware || function(req, res, next) { next()};
	var isRestify = (options.restifyServer);

	console.log('****************** SECOND middleware %j', middleware);
	
	if (isRestify) {
		restify = require('restify');
		router = options.restifyServer;
		// Incoming request bodies are JSON parsed.
		router.use(restify.bodyParser());
	} else {
		express = require('express');
		parser = require('body-parser');
		router = express.Router({
			caseSensitive: options.caseSensitive || true,
			strict: options.strict || true
		});
		// Incoming request bodies are JSON parsed.
		router.use(parser.json());
	}

	function api() {
		return router;
	}

	if (options.path) {
		if (options.path.charAt(options.path.length - 1) !== '/') {
			options.path = options.path + '/';
		}
	} else {
		options.path = '/';
	}

	for (var model in mongoose.models) {

		var resource = {
			path: options.path,
			version: options.version
		};

		var route = model;
		if (options.lowercase !== false) {
			route = route.toLowerCase();
		}

		if (options.pluralize) {
			route = pluralize(route);
		}

		resource.path = options.path + route;
		var Model = mongoose.model(model);
		var meanify = new Meanify(Model, options);

		console.log('********** AFTER INIT ******** %j', meanify);

		// Save route for manual middleware use case.
		api[route] = meanify;

		// Skip middleware routes for excluded models.
		if (options.exclude && options.exclude.indexOf(model) !== -1) {
			continue;
		}

		// Generate middlware routes
		console.log('meanify.search', meanify.search);
		router.get(isRestify ? resource: resource.path, meanify.search);
		console.log('%j', resource);
		debug('GET    ' + resource.path);
		router.post(isRestify ? resource: resource.path, middleware, meanify.create);
		debug('POST   ' + resource.path);
		if (options.puts) {
			router.put(isRestify ? resource: resource.path, middleware, meanify.create);
			debug('PUT    ' + resource.path);
		}
		resource.path += '/:id';
		router.get(isRestify ? resource: resource.path, middleware, meanify.read);
		debug('GET    ' + resource.path);
		if (options.puts) {
			router.put(isRestify ? resource: resource.path, middleware, meanify.update);
			debug('PUT    ' + resource.path);
		}
		router.post(isRestify ? resource: resource.path, middleware, meanify.update);
		debug('POST   ' + resource.path);
		isRestify ? router.del(resource, middleware, meanify.delete) : router.delete(resource.path, middleware, meanify.delete);
		debug('DELETE ' + resource.path);

		// Get the root before appending methods to path
		var root = resource.path;

		/* GENERATE METHOD ROUTES */
		var methods = Model.schema.methods;
		for (var method in methods) {
				resource.path += '/' + method;
				router.post(isRestify ? resource: resource.path, meanify.update[method]);
				debug('POST   ' + resource.path);
		}

		/* SUB-DOCUMENT ROUTES */
		// Re-assign path to root, removing methods
		resource.path = root;

		var paths = Model.schema.paths;
		var subpath;
		for (var field in paths) {
			var path = paths[field];

			if (path.caster && path.caster.options && path.caster.options.ref) {
				field = path.caster.options.ref;
				path.schema = true;
			}

			var resourceField = field.toLowerCase();
			if (options.pluralize) {
				resourceField = pluralize(resourceField);
			}

			if (path.schema) {
				resource.path = root + '/' + resourceField;
				console.log('meanify[field].search', meanify[field].search);
				router.get(isRestify ? resource: resource.path, meanify[field].search);
				debug('GET    ' + resource.path);
				router.post(isRestify ? resource: resource.path, middleware, meanify[field].create);
				debug('POST   ' + resource.path);
				if (options.puts) {
					router.put(isRestify ? resource: resource.path, middleware, meanify[field].create);
					debug('PUT    ' + resource.path);
				}
				resource.path += '/:' + resourceField + 'Id';
				router.get(isRestify ? resource: resource.path, middleware, meanify[field].read);
				debug('GET    ' + resource.path);
				router.post(isRestify ? resource: resource.path, middleware, meanify[field].update);
				debug('POST   ' + resource.path);
				if (options.puts) {
					router.put(isRestify ? resource: resource.path, middleware, meanify[field].update);
					debug('PUT    ' + resource.path);
				}
				isRestify ? router.del(resource, middleware, meanify[field].delete) : router.delete(resource.path, middleware, meanify[field].delete);
				debug('DELETE ' + resource.path);
			}
		}
	}

	return api;
};
