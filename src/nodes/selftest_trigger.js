// Pass through only when Shreya sent /selftest; everything else stops here
const { ctx } = $('Decide action').first().json;
return ctx && ctx.selftest && !ctx.unauthorized ? [{ json: { go: true } }] : [];
