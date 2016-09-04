'use strict';

const request = require('superagent');
const CM = require('cookie-manager');
const Pass = require('stream').PassThrough;

const isBrowser = (typeof window !== 'undefined');
const isFunction = data => (typeof data === 'function');

module.exports = function (defaults) {
    defaults = defaults || {};
    defaults.headers = defaults.headers || {};

    var cookie = {};

    if (!isBrowser) {
        defaults.headers['user-agent'] = defaults.headers['user-agent']
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/48.0.2564.109 Safari/537.36';

        if (!isBrowser) {
            this.cm = new CM();
        }
    }

    this.request = options => {
        return new Promise((resolve, reject) => {
            if (options.data && isFunction(options.data.pipe)) {
                let pass = new Pass();
                let buf = [];
                if (isFunction(options.data.getHeaders)) {
                    options.headers = options.data.getHeaders(options.headers)
                }
                pass.on('data', chunk => {
                    buf.push(chunk)
                });
                pass.on('end', () => {
                    let arr = new Uint8Array(Buffer.concat(buf));
                    options.data = arr.buffer;
                    resolve(options)
                });
                pass.on('error', err => {
                    reject(err)
                });
                options.data.pipe(pass)
            } else {
                resolve(options)
            }
        }).then(options => {
            if (!options.url) {
                return Promise.resolve();
            }
            if (this.cm) {
                cookie = options.url ? decodeURIComponent(this.cm.prepare(options.url)) : '';
            } else {
                cookie = {};
            }

            // make request
            return request[options.method.toLowerCase()](options.url)
                .query(options.params)
                .set({cookie})
                .send(options.data)
                .then((res) => {
                    if (this.cm) {
                        let setCookie = res.headers['set-cookie'];
                        if (setCookie) {
                            this.cm.store(options.url, setCookie);
                        }
                    }

                    res.data = options.type === 'json' ? JSON.parse(res.text) : res.text;
                    if (options.type === 'arraybuffer') {
                        res.data = res.body;
                    }

                    return res;
                })
                .catch((err) => err);
        })
    };

    return this.request;
};
