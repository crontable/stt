const fs = require('fs-extra');

fs.writeJsonSync(process.env.STT_FIXTURE_LEAF_RECORD, { pid: process.pid, parentPid: process.ppid });
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
