// Pass through only when Shreya asked for a test send
const { ctx } = $('Decide action').first().json;
return ctx && ctx.testsend && !ctx.unauthorized ? [{ json: { go: true } }] : [];
