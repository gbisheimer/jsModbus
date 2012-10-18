

var net = require('net');
var util = require('util');
var Put = require('put');

var Handler = require('./jsModbusHandler');

var log = function (msg) { util.log(msg); };
var dummy = function () { };

var modbusProtocolVersion = 0,
    modbusUnitIdentifier = 1;


exports.setLogger = function (logger) {
  log = logger;
};

var ModbusClient = function (port, host, mock) {

  if (!(this instanceof ModbusClient)) {
    return new ModbusClient(port, host, mock);
  }

  var that = this;

  // connect to host
  var mNet = !mock?net:mock;

  this.isConnected = false;
  this.client = mNet.connect(port, host );

  log('Connecting to ' + host + ':' + port);
  this.client.on('connect', function () {
    // release pipe content if there are any yet
    log('Connection established.');
    that.isConnected = true;
    that.flush();
  });

  // setup data receiver
  this.client.on('data', this.handleData(this));

  this.pkgPipe = [];
  this.cbPipe = [];

  this.identifier = 0;

  /**
   *  Public functions, in general all implementations from 
   *  the function codes
   */
  var api = {

    readCoils: function (start, quantity, cb) {
      var fc  = 1,
	  pdu = that.pduWithTwoParameter(fc, start, quantity);

      that.makeRequest(fc, pdu, !cb?dummy:cb);
    },

    readInputRegister: function (start, quantity, cb) {

      // 0. check start and quantity

      // 1. create pdu and response-pdu handler
      var fc      = 4, 
          pdu     = that.pduWithTwoParameter(fc, start, quantity);

      that.makeRequest(fc, pdu, !cb?dummy:cb);

    },

    writeSingleCoil: function (address, value, cb) {

      var fc = 5,
	  pdu = that.pduWithTwoParameter(fc, address, value?0xff00:0x0000);

      that.makeRequest(fc, pdu, !cb?dummy:cb);

    },

    close: function () {
      that.client.end();
    }
  };

  return api;

};

var proto = ModbusClient.prototype;

/**
 * Pack up the pdu and the handler function
 * and pipes both. Calls flush in the end.
 */
proto.makeRequest = function (fc, pdu, cb) {

  var pkgObj = this.buildPackage(pdu),
      cbObj = { id: pkgObj.id, fc: fc, cb: cb };

  this.pkgPipe.push(pkgObj);
  this.cbPipe.push(cbObj);

  this.flush();

}

/**
 *  Iterates through the package pipe and 
 *  sends the requests
 */
proto.flush = function () {

  if (!this.isConnected) {
    return;
  }

  while (this.pkgPipe.length > 0) {
    var pkgObj = this.pkgPipe.shift();
    var mbap = pkgObj.pkg;

    log('sending data');
    console.log(mbap);
    this.client.write(mbap);
  }
}

/**
 *  Builds an MBAP Package with respect to the
 *  pdu. Very straightforward.
 */
proto.buildPackage = function (pdu) {
  
  var newId = this.identifier++;
  var pkgObj = {
	id : newId,
	pkg : Put()
    	.word16be(this.identifier)
    	.word16be(this.modbusProtocolVersion)
    	.word16be(pdu.length + 1)
    	.word8(modbusUnitIdentifier)
    	.put(pdu)
    	.buffer()
  };

  return pkgObj;

}

/**
 *  Returns the main response handler
 */
proto.handleData = function (that) {

  /**
   *  This is the main response handler. It simply
   *  reads the mbap first and dispatches the 
   *  pdu to the next callback in the pipe (I am not sure
   *  if the requests are handled in sequence but this is 
   *  definitivly a place where errors can occure due to wrong
   *  assigned callbacks, keep that in mind.)
   */
  return function (data) {

    log('received data');

    var buf = new Buffer(data);
    var cnt = 0;

    while (cnt < buf.length) {

      // 1. extract mbap

      var mbap = { 
        transId  : buf.readUInt16BE(0),
        protoId  : buf.readUInt16BE(2),
        length   : buf.readUInt16BE(4),
        unitId   : buf.readUInt8(6) };

      cnt += 7;

      log("MBAP extracted");

      // 2. extract pdu
      buf = buf.slice(0, 7 + mbap.length - 1);
      cnt += mbap.length - 1;

      var pdu = buf.slice(7, 7 + mbap.length - 1);
      log("PDU extracted");

      // 3. dequeue callback and make the call with the pdu
      var cbObj = that.cbPipe.shift();
      log("Fetched Callback Object from pipe with id " + cbObj.id);

      // 4. check pdu for errors
      log("Checking pdu for errors");
      if (that.handleErrorPDU(pdu, cbObj.cb)) {
        continue;
      }      

      log("Calling Callback with pdu.");
      var handler = Handler.ResponseHandler[cbObj.fc];
      if (!handler) { 
	throw "No handler implemented.";
      }
      handler(pdu, cbObj.cb);
    }
  }

}

/**
 *  Check if the given pdu contains fc > 0x84 (error code)
 *  and return false if not, otherwise handle the error,
 *  call cb(null, err) and return true
 */
proto.handleErrorPDU = function (pdu, cb) {
  
  var errorCode = pdu.readUInt8(0);

  if (errorCode < 0x80) {
    return false;
  }

  log("PDU describes an error.");
  var exceptionCode = pdu.readUInt8(1);
  var message = Handler.ExceptionMessage[exceptionCode];

  var err = { 
	errorCode: errorCode, 
	exceptionCode: exceptionCode, 
	message: message
  };
  
  cb(null, err);

  return true; 
};

/**
 *  Many requests look like this so I made
 *  this an extra function.
 */
proto.pduWithTwoParameter = function (fc, start, quantity) {
  return Put()
	.word8(fc)
	.word16be(start)
	.word16be(quantity)
	.buffer();
}

exports.create = ModbusClient;

