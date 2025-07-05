const selfsigned = require('selfsigned');
const fs = require('fs');

const attrs = [{ name: 'commonName', value: 'localhost' }];
const pems = selfsigned.generate(attrs, { days: 365 });

fs.writeFileSync('./certs/server.cert', pems.cert);
fs.writeFileSync('./certs/server.key', pems.private);

console.log('✅ Self-signed certificate generated in ./certs/');
