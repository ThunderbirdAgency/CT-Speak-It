const {version}=require('../package.json');
if(process.env.REF_TYPE==='tag'&&process.env.RELEASE_REF!=='v'+version)throw new Error('Tag must match desktop/package.json version.');
console.log('Release version: '+version);
