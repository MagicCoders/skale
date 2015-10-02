#!/usr/bin/env node

// Todo:
// - record/replay input messages
// - handle foreign messages
// - authentication (register)
// - statistics in monitoring
// - topics permissions (who can publish / subscribe)

'use strict';

var child_process = require('child_process');
var fs = require('fs');
var net = require('net');
var util = require('util');
var os = require('os');
var trace = require('line-trace');
var stream = require('stream');
var tmp = require('tmp');
var uuidGen = require('node-uuid');
var UgridClient = require('../lib/ugrid-client.js');
var webSocketServer = require('ws').Server;
var websocket = require('websocket-stream');

var express = require('express');
var app = express();
var bodyParser = require('body-parser');

app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

var wsid = 1;	// worker stock id
var expectedWorkers = 0;	// number of expected workers per stock
var workerStock = [];
var workerControllers = [];
var pendingMasters = [];

var opt = require('node-getopt').create([
	['h', 'help', 'print this help text'],
	['H', 'Host=ARG', 'primary server host (default none)'],
	['l', 'local=ARG', 'start local worker and master controllers (default ncpu workers)'],
	['n', 'name=ARG', 'advertised server name (default localhost)'],
	['P', 'Port=ARG', 'primary server port (default none)'],
	['p', 'port=ARG', 'server port (default 12346)'],
	['w', 'wsport=ARG', 'listen on websocket port (default none)'],
	['v', 'version', 'print version']
]).bindHelp().parseSystem();

var clients = {};
var clientNum = 1;
var clientMax = UgridClient.minMulticast;
var minMulticast = UgridClient.minMulticast;
var topics = {};
var topicNum = -1;
var UInt32Max = 4294967296;
var topicMax = UInt32Max - minMulticast;
var topicIndex = {};
//var name = opt.options.name || 'localhost';		// Unused until FT comes back
var port = opt.options.port || 12346;
var wss;
var wsport = opt.options.wsport || port + 2;
var crossbar = {};

function SwitchBoard(sock) {
	if (!(this instanceof SwitchBoard))
		return new SwitchBoard(sock);
	stream.Transform.call(this, {objectMode: true});
	sock.index = getClientNumber();
	crossbar[sock.index] = sock;
	this.sock = sock;
}
util.inherits(SwitchBoard, stream.Transform);

SwitchBoard.prototype._transform = function (chunk, encoding, done) {
	var o = {}, to = chunk.readUInt32LE(0, true);
	if (to >= minMulticast)	{	// Multicast
		var sub = topics[to - minMulticast].sub, len = sub.length, n = 0;
		if (len === 0) return done();
		for (var i in sub) {
			// Flow control: adjust to the slowest receiver
			if (crossbar[sub[i]]) {
				crossbar[sub[i]].write(chunk, function () {
					if (++n == len) done();
				});
			} else if (--len === 0) done();
		}
	} else if (to > 1) {	// Unicast
		if (crossbar[to])
			crossbar[to].write(chunk, done);
		else done();
	} else if (to === 1) {	// Foreign (to be done)
	} else if (to === 0) {	// Server request
		try {
			o = JSON.parse(chunk.slice(8));
		} catch (error) {
			console.error(error);
			return done();
		}
		if (!(o.cmd in clientRequest)) {
			o.error = 'Invalid command: ' + o.cmd;
			o.cmd = 'reply';
			this.sock.write(UgridClient.encode(o), done);
		} else if (clientRequest[o.cmd](this.sock, o)) {
			o.cmd = 'reply';
			this.sock.write(UgridClient.encode(o), done);
		} else done();
	}
};

// Client requests functions, return true if a response must be sent
// to client, false otherwise. Reply data, if any,  must be set in msg.data.
var clientRequest = {
	connect: function (sock, msg) {
		var i, ret = true, master;
		register(null, msg, sock);
		if (msg.data.query) msg.data.devices = devices(msg);
		if (msg.data.notify in clients && clients[msg.data.notify].sock) {
			clients[msg.data.notify].sock.write(UgridClient.encode({cmd: 'notify', data: msg.data}));
			clients[msg.data.notify].closeListeners[msg.data.uuid] = true;
		}
		if (msg.data.type == 'worker-controller') {
			msg.data.wsid = wsid;
			expectedWorkers += msg.data.ncpu;
			workerControllers.push(msg.data);
		} else if (msg.data.type == 'worker') {
			if (wsid == msg.data.wsid) {
				workerStock.push(msg.data);
				if (pendingMasters.length && workerStock.length >= expectedWorkers) {
					master = pendingMasters.shift();
					master.data.devices = workerStock;
					master.cmd = 'reply';
					if (clients[master.data.uuid].sock)
						clients[master.data.uuid].sock.write(UgridClient.encode(master));
					postMaster(master.data.uuid);
				}
			}
		} else if (msg.data.type == 'master') {
			if (expectedWorkers && workerStock.length >= expectedWorkers) {
				msg.data.devices = workerStock;
				postMaster(msg.data.uuid);
			} else {
				pendingMasters.push(msg);
				ret = false;
			}
		}
		console.log('## Connect %s %s %s', msg.data.type, msg.data.id, msg.data.uuid);
		return ret;

		function postMaster(muuid) {
			// Setup notifications to terminate workers on master end
			for (i = 0; i < workerStock.length; i++) {
				clients[muuid].closeListeners[workerStock[i].uuid] = true;
			}
			// Pre-fork new workers to renew the stock
			wsid++;
			workerStock = [];
			for (i = 0; i < workerControllers.length; i++) {
				clients[workerControllers[i].uuid].sock.write(UgridClient.encode({
					cmd: 'getWorker',
					wsid: wsid,
					n: workerControllers[i].ncpu
				}));
			}
		}
	},
	devices: function (sock, msg) {
		msg.ufrom = sock.client.uuid;
		msg.data = devices(msg);
		return true;
	},
	end: function (sock) {
		sock.client.end = true;
		return false;
	},
	get: function (sock, msg) {
		msg.data = clients[msg.data] ? clients[msg.data].data : null;
		return true;
	},
	id: function (sock, msg) {
		msg.data = msg.data in clients ? clients[msg.data].index : null;
		return true;
	},
	notify: function (sock, msg) {
		if (clients[msg.data])
			clients[msg.data].closeListeners[sock.client.uuid] = true;
		return false;
	},
	set: function (sock, msg) {
		if (typeof msg.data != 'object') return false;
		for (var i in msg.data)
			sock.client.data[i] = msg.data[i];
		pubmon({event: 'set', uuid: sock.client.uuid, data: msg.data});
		return false;
	},
	subscribe: function (sock, msg) {
		subscribe(sock.client, msg.data);
		return false;
	},
	tid: function (sock, msg) {
		var topic = msg.data;
		var n = msg.data = getTopicId(topic);
		// First to publish becomes topic owner
		if (!topics[n].owner) {
			topics[n].owner = sock.client;
			sock.client.topics[n] = true;
		}
		return true;
	},
	unsubscribe: function (sock, msg) {
		unsubscribe(sock.client, msg.data);
		return false;
	}
};

// Create a source stream and topic for monitoring info publishing
var mstream = new SwitchBoard({});
var monid =  getTopicId('monitoring') + minMulticast;
function pubmon(data) {
	mstream.write(UgridClient.encode({cmd: 'monitoring', id: monid, data: data}));
}

console.log("## Started " + Date());
// Start a TCP server
if (port) {
	net.createServer(handleConnect).listen(port);
	console.log("## Listening TCP on " + port);
}

// Start a websocket server if a listening port is specified on command line
if (wsport) {
	console.log("## Listening WebSocket on " + wsport);
	wss = new webSocketServer({port: wsport});
	wss.on('connection', function (ws) {
		var sock = websocket(ws);
		sock.ws = true;
		handleConnect(sock);
		// Catch error/close at websocket level in addition to stream level
		ws.on('close', function () {
			handleClose(sock);
		});
		ws.on('error', function (error) {
			console.log('## websocket connection error');
			console.log(error.stack);
		});
	});
}

// Start local workers if required
if (opt.options.local) {
	var nworker = (opt.options.local > 0) ? opt.options.local : os.cpus().length;
	trace(nworker)
	child_process.spawn(__dirname + '/worker.js', ['-n', nworker], {stdio: 'inherit'});
}

// Start web server
var webServer = app.listen(8000, function () {
	var addr = webServer.address();
	trace('webserver listening at %j', addr);
});

app.get('/', function (req, res) {res.send('Hello from ugrid server\n');});

app.get('/test', function (req, res) {req.query.from = "ugrid get test"; res.json(req.query);});

app.post('/test', function (req, res) {req.body.from = "ugrid post test"; res.json(req.body);});

// Exec a master from an already existing file
app.post('/exec', function (req, res) {
	try {
		child_process.execFile(req.body.src, req.body.args, function (err, stdout, stderr) {
			res.send({err: err, stdout: stdout, stderr: stderr});
		});
	} catch (err) {
		res.send({err: 1, stdout: null, stderr: 'exec failed on server: ' + err.message});
	}
});

// Exec a master using src embedded in request. A temporary file is used.
app.post('/run', function (req, res) {
	var name = tmp.tmpNameSync({template: __dirname + '/tmp/XXXXXX.js'});
	req.setTimeout(0);
	fs.writeFile(name, req.body.src, {mode: 493}, function (err) {
		if (err) {
			res.send({err: 1, stdout: null, stderr: 'write failed on server: ' + err.message});
			return;
		}
		try {
			child_process.execFile(name, req.body.args, function (err, stdout, stderr) {
				res.send({err: err, stdout: stdout, stderr: stderr});
			});
		} catch (err) {
			res.send({err: 1, stdout: null, stderr: 'exec failed on server: ' + err.message});
		}
	});
});

function handleClose(sock) {
	var i, cli = sock.client;
	if (cli) {
		console.log('## Close: %s %s %s', cli.data.type, cli.index, cli.uuid);
		pubmon({event: 'disconnect', uuid: cli.uuid});
		cli.sock = null;
		releaseWorkers(cli.uuid);
		if (cli.data.type == 'worker-controller') {
			// resize stock capacity
			expectedWorkers -= cli.data.ncpu;
			for (i = 0; i < workerControllers.length; i++) {
				if (cli.uuid == workerControllers[i].uuid) {
					workerControllers.splice(i, 1);
				}
			}
		} else if (cli.data.type == 'worker') {
			// remove worker from stock
			for (i = 0; i < workerStock.length; i++) {
				if (cli.uuid == workerStock[i].uuid)
					workerStock.splice(i, 1);
			}
		} else if (cli.data.type == 'master') {
			// remove master from pending masters, avoiding future useless workers start
			for (i in pendingMasters) {
				if (pendingMasters[i].data.uuid == cli.uuid) {
					pendingMasters.splice(i, 1);
					break;
				}
			}
		}
		for (i in cli.closeListeners) {
			if (clients[i].sock)
				clients[i].sock.write(UgridClient.encode({cmd: 'remoteClose', data: cli.uuid}));
		}
		for (i in cli.topics) {		// remove owned topics
			delete topicIndex[topics[i].name];
			delete topics[i];
		}
		if (cli.end) delete clients[cli.uuid];
	} else {
		console.log('## Close: %j', sock._peername);
	}
	if (sock.index) delete crossbar[sock.index];
	sock.removeAllListeners();
}

function handleConnect(sock) {
	if (sock.ws) { 
		console.log('## Connect websocket from ' + sock.socket.upgradeReq.headers.origin);
	} else {
		console.log('## Connect tcp ' + sock.remoteAddress + ' ' + sock.remotePort);
		sock.setNoDelay();
	}
	sock.pipe(new UgridClient.FromGrid()).pipe(new SwitchBoard(sock));
	sock.on('end', function () {
		handleClose(sock);
	});
	sock.on('error', function (error) {
		console.log('## connection error');
		console.log(error);
	});
}

function getClientNumber() {
	var n = 100000;
	do {
		clientNum = (clientNum < clientMax) ? clientNum + 1 : 2;
	} while (clientNum in crossbar && --n);
	if (!n) throw new Error("getClientNumber failed");
	return clientNum;
}

function register(from, msg, sock)
{
	var uuid = msg.uuid || uuidGen.v1();
	sock.client = clients[uuid] = {
		index: sock.index,
		uuid: uuid,
		owner: from ? from : uuid,
		data: msg.data || {},
		sock: sock,
		topics: {},
		closeListeners: {}
	};
	pubmon({event: 'connect', uuid: uuid, data: msg.data});
	//msg.data = {uuid: uuid, token: 0, id: sock.index};
	if (!msg.data) msg.data = {};
	msg.data.uuid = uuid;
	msg.data.token = 0;
	msg.data.id = sock.index;
}

function releaseWorkers(master) {
	for (var i in clients) {
		var d = clients[i].data;
		if (d && d.jobId == master)
			d.jobId = "";
	}
}

function devices(msg) {
	var query = msg.data.query, result = [], master;
	var workers = [];

	for (var i in clients) {
		if (!clients[i].sock) continue;
		var match = true;
		for (var j in query) {
			if (!clients[i].data || clients[i].data[j] != query[j]) {
				match = false;
				break;
			}
		}
		if (match) {
			result.push({
				uuid: i,
				id: clients[i].index,
				ip: clients[i].sock.remoteAddress,
				data: clients[i].data
			});
		}
	}
	return result;
}

function getTopicId(topic) {
	if (topic in topicIndex) return topicIndex[topic];
	var n = 10000;
	do {
		topicNum = (topicNum < topicMax) ? topicNum + 1 : 0;
	} while (topicNum in topics && --n);
	if (!n) throw new Error("getTopicId failed");
	topics[topicNum] = {name: topic, id: topicNum, sub: []};
	topicIndex[topic] = topicNum;
	return topicIndex[topic];
}

function subscribe(client, topic) {
	var sub = topics[getTopicId(topic)].sub;
	if (sub.indexOf(client.index) < 0)
		sub.push(client.index);
}

function unsubscribe(client, topic) {
	if (!(topic in topicIndex)) return;
	var sub = topics[topicIndex[topic]].sub, i = sub.indexOf(client.index);
	if (i >= 0) sub.splice(i, 1);
}
