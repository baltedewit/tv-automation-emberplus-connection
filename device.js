const EventEmitter = require('events').EventEmitter;
const util = require('util');
const Promise = require('bluebird');
const S101Client = require('./client.js').S101Socket;
const ember = require('./ember.js');
const BER = require('./ber.js');
const errors = require('./errors.js');


function DeviceTree(host, port) {
    DeviceTree.super_.call(this);
    var self = this;
    self.timeoutValue = 2000;
    self.client = new S101Client(host, port);
    self.root = new ember.Root();
    self.pendingRequests = [];
    self.activeRequest = null;
    self.timeout = null;
    self.callback = undefined;

    self.client.on('connecting', () => {
        self.emit('connecting');
    });

    self.client.on('connected', () => {
        self.emit('connected');
        if (self.callback !== undefined) {
            self.callback();
        }
    });

    self.client.on('disconnected', () => {
        self.emit('disconnected');
    });

    self.client.on("error", (e) => {
        if (self.callback !== undefined) {
            self.callback(e);
        }
        self.emit("error", e);
    });

    self.client.on('emberTree', (root) => {
        self.handleRoot(root);
        if (self.callback) {
            self.callback(undefined, root);
        }
    });
}

util.inherits(DeviceTree, EventEmitter);


DecodeBuffer = function(packet) {
     var ber = new BER.Reader(packet);
     return ember.Root.decode(ber);
}

DeviceTree.prototype.saveTree = function(f) {
    var writer = new BER.Writer();
    this.root.encode(writer);
    f(writer.buffer);
}

DeviceTree.prototype.connect = function(timeout = 2) {
    return new Promise((resolve, reject) => {
        this.callback = (e) => {
            if (e === undefined) {
                return resolve();
            }
            return reject(e);
        };
        this.client.connect(timeout);
    });
}

DeviceTree.prototype.expand = function(node)
{
    let self = this;
    return new Promise((resolve, reject) => {
        //console.log("Getting directory for node", node);
        self.getDirectory(node).then((res) => {
            if ((res === undefined) || (node.children === undefined)) {
                //console.log("No more children for ", node);
                return resolve();
            }
            let p = [];
            for(let child of node.children) {
                //console.log("Expanding child", child);
                p.push(self.expand(child));
            }
            return Promise.all(p)
        }).then(() => {resolve();});
    });
}

DeviceTree.prototype.getDirectory = function(qnode) {
    var self = this;
    if (qnode === undefined) {
        self.root.clear();
        qnode = self.root;
    }
    return new Promise((resolve, reject) => {
        self.addRequest((error) => {
            if (error) {
                self.finishRequest();
                reject(error);
                return;
            }

            let cb = (error, node) => {
                self.finishRequest();
                if (error) {
                    reject(error);
                }
                else {
                    //console.log("Received getDirectory response", node);
                    resolve(node);
                }
            };

            //console.log("Sending getDirectory");
            self.callback = cb;
            self.client.sendBERNode(qnode.getDirectory());
        });
    });
}

DeviceTree.prototype.disconnect = function() {
    this.client.disconnect();
}

DeviceTree.prototype.makeRequest = function() {
    var self=this;
    if(self.activeRequest === null && self.pendingRequests.length > 0) {
        self.activeRequest = self.pendingRequests.shift();

        self.timeout = setTimeout(() => {
            self.timeoutRequest();
        }, self.timeoutValue);

        self.activeRequest();
    }
};

DeviceTree.prototype.addRequest = function(cb) {
    var self=this;
    self.pendingRequests.push(cb);
    self.makeRequest();
}

DeviceTree.prototype.finishRequest = function() {
    var self=this;
    self.callback = undefined;
    if(self.timeout != null) {
        clearTimeout(self.timeout);
        self.timeout = null;
    }
    self.activeRequest = null;
    self.makeRequest();
}

DeviceTree.prototype.timeoutRequest = function() {
    var self = this;
    self.root.cancelCallbacks();
    self.activeRequest(new errors.EmberTimeoutError('Request timed out'));
}

DeviceTree.prototype.handleRoot = function(root) {
    var self=this;

    //console.log("handling root", JSON.stringify(root));
    var callbacks = self.root.update(root);
    if(root.elements !== undefined) {
        for(var i=0; i<root.elements.length; i++) {
            if (root.elements[i].isQualified()) {
                callbacks = callbacks.concat(this.handleQualifiedNode(this.root, root.elements[i]));
            }
            else {
                callbacks = callbacks.concat(this.handleNode(this.root, root.elements[i]));
            }
        }

        // Fire callbacks once entire tree has been updated
        for(var i=0; i<callbacks.length; i++) {
            //console.log('hr cb');
            callbacks[i]();
        }
    }
}

DeviceTree.prototype.handleQualifiedNode = function(parent, node) {
    var self=this;
    var callbacks = [];
    //console.log(`handling element with a path ${node.path}`);
    var element = parent.getElementByPath(node.path);
    if (element !== null) {
        //console.log("Found element", JSON.stringify(element));
        callbacks = element.update(node);
    }
    else {
        //console.log("new element", JSON.stringify(node));
        var path = node.path.split(".");
        if (path.length === 1) {
            this.root.addChild(node);
        }
        else {
            // Let's try to get the parent
            path.pop();
            parent = this.root.getElementByPath(path.join("."));
            if (parent === null) {
                return callbacks;
            }
            parent.addChild(node);
        }
        element = node;
    }

    var children = node.getChildren();
    if(children !== null) {
        for(var i=0; i<children.length; i++) {
            if (children[i].isQualified()) {
                callbacks = callbacks.concat(this.handleQualifiedNode(element, children[i]));
            }
            else {
                callbacks = callbacks.concat(this.handleNode(element, children[i]));
            }
        }
    }

    callbacks = parent.update();

    return callbacks;
}

DeviceTree.prototype.handleNode = function(parent, node) {
    var self=this;
    var callbacks = [];

    var n = parent.getElementByNumber(node.number);
    if(n === null) {
        parent.addChild(node);
        n = node;
    } else {
        callbacks = n.update(node);
    }

    var children = node.getChildren();
    if(children !== null) {
        for(var i=0; i<children.length; i++) {
            callbacks = callbacks.concat(this.handleNode(n, children[i]));
        }
    }

    //console.log('handleNode: ', callbacks);
    return callbacks;
}

DeviceTree.prototype.getNodeByPath = function(path) {
    var self=this;
    if(typeof path === 'string') {
        path = path.split('/');
    }

    return new Promise((resolve, reject) => {
        self.addRequest((error) => {
            if(error) {
                reject(error);
                self.finishRequest();
                return;
            }
            self.root.getNodeByPath(self.client, path, (error, node) => {
                if(error) {
                    reject(error);
                } else {
                    resolve(node);
                }
                self.finishRequest();
            });
        });
    });
}

DeviceTree.prototype.subscribe = function(node, callback) {
    if(node instanceof ember.Parameter && node.isStream()) {
        // TODO: implement
    } else {
        node.addCallback(callback);
    }
}

DeviceTree.prototype.setValue = function(node, value) {
    var self=this;
    return new Promise((resolve, reject) => {
        if((!(node instanceof ember.Parameter)) &&
            (!(node instanceof ember.QualifiedParameter)))
        {
            reject(new errors.EmberAccessError('not a property'));
        }
        else if(node.contents !== undefined && node.contents.value == value) {
            resolve(node);
        } else {
            //console.log('setValue', node.getPath(), value);
            self.addRequest((error) => {
                if(error) {
                    reject(error);
                    self.finishRequest();
                    return;
                }

                let cb = (error, node) => {
                    self.finishRequest();
                    if (error) {
                        reject(error);
                    }
                    else {
                        resolve(node);
                    }
                };

                self.callback = cb;
                self.client.sendBERNode(node.setValue(value));
            });
        }
    });
}

function TreePath(path) {
    this.identifiers = [];
    this.numbers = [];

    if(path !== undefined) {
        for(var i=0; i<path.length; i++) {
            if(Number.isInteger(path[i])) {
                this.numbers.push(path[i]);
                this.identifiers.push(null);
            } else {
                this.identifiers.push(path[i]);
                this.numbers.push(null);
            }
        }
    }
}


module.exports = {DeviceTree, DecodeBuffer};
