// Lets `node --test apps/ten-dollar-words/tests/` work on Node 22+, which treats a directory
// argument as a module path. Older versions find the *.test.js files themselves.
require('./engine.test.js');
require('./notion-map.test.js');
require('./spell.test.js');
require('./inline.test.js');
require('./formats.test.js');
