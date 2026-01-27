process.env.NODE_ENV = 'test';
process.env.OPENAI_API_KEY = 'sk-test';
try {
    const app = require('../index');
    console.log('OK');
} catch (e) {
    console.error('REQUIRE ERROR', e);
    process.exit(1);
}