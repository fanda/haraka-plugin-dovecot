'use strict';

var net = require('net');

exports.register = function () {
	var plugin = this;
	plugin.register_hook('mail_from', 'mail_from_dovecot_access');
};


exports.load_dovecot_ini = function () {
	var plugin = this;
	plugin.cfg = plugin.config.get(
        'mail_from.dovecot_access.ini',
        function () {
        plugin.load_dovecot_ini();
    });
};


exports.mail_from_dovecot_access = function (next, connection, params) {
	var plugin = this;

	// determine if MAIL FROM domain is local
	var txn = connection.transaction;

	var email = params[0].address();
	if (!email) { // likely an IP with relaying permission
		txn.results.add(plugin, {
			skip : 'mail_from.null',
			emit : true
		});
		return next();
	}

	var domain = params[0].host.toLowerCase();

	var cb = function (err, result) {
		if (err) {
			txn.results.add(plugin, {
				err : err
			});
			return next(DENYSOFT, err);
		}

		// the MAIL FROM sender is verified as a local address
		if (result[0] === OK) {
			txn.results.add(plugin, {
				pass : "mail_from." + result[1]
			});
			txn.notes.local_sender = true;
			return next();
		}

		if (result[0] === undefined) {
			txn.results.add(plugin, {
				err : "mail_from." + result[1]
			});
			return next();
		}

		txn.results.add(plugin, {
			msg : "mail_from." + result[1]
		});

		return next(CONT, "mail_from." + result[1]);
	};

	plugin.get_dovecot_response(connection, domain, email, cb);
};


exports.get_dovecot_response = function (connection, domain, email, cb) {
	var plugin = this;
	var options = {};

	if (plugin.cfg[domain]) {
		if (plugin.cfg[domain].path) {
			options.path = plugin.cfg[domain].path;
		} else {
			if (plugin.cfg[domain].host) {
				options.host = plugin.cfg[domain].host;
			}
			if (plugin.cfg[domain].port) {
				options.port = plugin.cfg[domain].port;
			}
		}
	} else {
		if (plugin.cfg.main.path) {
			options.path = plugin.cfg.main.path;
		} else {
			if (plugin.cfg.main.host) {
				options.host = plugin.cfg.main.host;
			}
			if (plugin.cfg.main.port) {
				options.port = plugin.cfg.main.port;
			}
		}
	}

	connection.logdebug(plugin, "checking " + email);
	var client = net.connect(
        options,
		function () { //'connect' listener
			connection.logprotocol(plugin, 'connect to Dovecot auth-master:' + JSON.stringify(options));
		});
	client.on('data', function (chunk) {
		connection.logprotocol(plugin, 'BODY: ' + chunk);
		var data = chunk.toString();
		var arr = exports.check_dovecot_response(data);
		if (arr[0] === CONT) {
			var username = 'postmaster\@example.com';
			var send_data = 'VERSION\t1\t0\n' +
				'USER\t1\t' + email.replace("@", "\@") + '\tservice=smtp\n';

			client.write(send_data);
		} else {
			cb(undefined, arr);
		}
	});
	client.on('error', function (e) {
		client.end();
		return cb(e);
	});
	client.on('end', function () {
		connection.logprotocol(plugin, 'closed connect to Dovecot auth-master');
	});
};

exports.check_dovecot_response = function (data) {
	if (data.match(/^VERSION\t\d+\t/i) && data.slice(-1) === '\n') {
		return [CONT, 'Send now username to check process.'];
	} else if (data.match(/^USER\t1/i) && data.slice(-1) === '\n') {
		return [OK, 'Mailbox found.'];
	} else if (data.match(/^FAIL\t1/i) && data.slice(-1) === '\n') {
		return [DENYSOFT, 'Temporarily undeliverable: internal communication broken'];
	} else {
		return [undefined, 'Mailbox not found.'];
	}
};
