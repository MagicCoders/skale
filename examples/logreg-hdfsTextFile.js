#!/usr/local/bin/node --harmony
'use strict';

var co = require('co');
var ugrid = require('../lib/ugrid-context.js')();
var ml = require('../lib/ugrid-ml.js');

co(function *() {
	yield ugrid.init();

	var D = 16;
	var file = process.argv[2];
	var iterations = process.argv[3] || 1;
	var rng = new ml.Random(1);
	var w = rng.randn(D);
	
	function parse(e) {
		var tmp = e.split(' ').map(parseFloat);
		return {label: tmp.shift(), features: tmp}
	}

	var points = ugrid.textFile(file).map(parse).persist();
	// This yield trigger hdfs query two times, revealing bug located in preBuild function
	// var N = yield points.count();
	var N = 328500;

	for (var i = 0; i < iterations; i++) {
		var gradient = yield points.map(ml.logisticLossGradient, [w]).reduce(ml.sum, ml.zeros(D));
		for (var j = 0; j < w.length; j++)
			w[j] -= gradient[j] / (N * Math.sqrt(i + 1));
	}
	console.log(w.join(' '));
	ugrid.end();
})();
