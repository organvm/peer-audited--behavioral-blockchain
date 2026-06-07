// existing code...

const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../../.env');
const envLocalPath = path.join(__dirname, '../../.env.local');

const envContent = fs.readFileSync(envPath, 'utf8');
const envLocalContent = fs.readFileSync(envLocalPath, 'utf8');

const env = dotenv.parse(envContent);
const envLocal = dotenv.parse(envLocalContent);

Object.assign(process.env, env);
Object.assign(process.env, envLocal);

// existing code...