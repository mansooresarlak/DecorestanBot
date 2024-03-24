import {Ai} from '@cloudflare/ai';
import {Bot, Composer, GrammyError, HttpError, InputFile, lazySession, webhookCallback} from 'grammy';
import {Env, CustomApi, CustomContext, SessionData} from './types';
import routers from './routers';
import composers from './composers';
import {autoChatAction} from '@grammyjs/auto-chat-action';
import {D1Adapter} from '@grammyjs/storage-cloudflare';
import {hydrateApi, hydrateContext} from '@grammyjs/hydrate';
import {Hono} from 'hono';
import {hasResponse, sha256} from './lib';
import {HTTPException} from 'hono/http-exception';
import {Router} from '@grammyjs/router';
import consts from './consts';

const app = new Hono<Env>();

app.get('/ai', async ctx => {
  const ai = new Ai(ctx.env?.AI);
  const messages = [
    {role: 'system', content: 'You are a friendly assistant'},
    {role: 'user', content: 'What is the origin of the phrase Hello, World'},
  ];
  const inputs = {messages};
  const response = await ai.run('@cf/meta/llama-2-7b-chat-fp16', inputs).then(response => (hasResponse(response) ? response.response : ''));
  return ctx.json(`Hello World! ${response}`);
});

app.get('/:sha256_bot_token/webhook/:webhook_command', async ctx => {
  const {sha256_bot_token, webhook_command} = ctx.req.param();
  const sha256BotToken = await sha256(ctx.env.BOT_TOKEN);
  if (sha256_bot_token !== sha256BotToken) {
    return new Response();
  }
  const bot = new Bot<CustomContext, CustomApi>(ctx.env.BOT_TOKEN);
  if (webhook_command === 'del') {
    await bot.api.deleteWebhook();
    return ctx.json(null);
  } else if (webhook_command === 'getInfo') {
    const response = await bot.api.getWebhookInfo();
    return ctx.json(response);
  } else if (webhook_command === 'set') {
    const workerURL = ctx.req.url.replace(ctx.req.path, '/bot');
    await bot.api.setWebhook(workerURL);
    return ctx.json(null);
  }
  return ctx.json(null, 404);
});

app.use('/bot', async (ctx, next) => {
  const bot = new Bot<CustomContext, CustomApi>(ctx.env.BOT_TOKEN);
  const initial = (): SessionData => ({
    decor: {},
    leftOperand: 0,
    rightOperand: 0,
    route: '',
  });
  const getSessionKey = (ctx: Omit<CustomContext, 'session'>) =>
    ctx.from === undefined || ctx.chat === undefined ? undefined : `${ctx.chat.id}:${ctx.from.id}`;
  const storage = await D1Adapter.create<SessionData>(ctx.env.D1, 'SessionData');
  const composer = new Composer<CustomContext>();

  bot.api.config.use(hydrateApi());

  const router = new Router<CustomContext>(async ctx => (await ctx.session).route);
  router.route('decor-q8', async ctx2 => {
    const metadata = consts.lighting.filter(a => a.text === ctx2.msg?.text);
    if (metadata.length === 0) {
      await ctx2.reply('لطفا یک روشنایی درست انتخاب کن.', {
        // reply_markup: {remove_keyboard: true},
      });
      return;
    }

    const session = await ctx2.session;
    session.decor.Q8 = metadata[0].data;

    session.route = '';
    ctx2.chatAction = 'upload_photo';
    // await ctx2.reply('image is processing. please wait...');
    const ai = new Ai(ctx.env?.AI);
    const prompt = Object.entries(session.decor)
      .map(a => a[1])
      .join(' ');
    const inputs = {prompt};
    const response = await ai.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', inputs);
    const inputFile = new InputFile(response);
    await ctx2.replyWithPhoto(inputFile, {
      reply_markup: {remove_keyboard: true},
    });
  });

  bot
    .use(lazySession({initial, getSessionKey, storage}))
    .use(hydrateContext<CustomContext>())
    .use(autoChatAction<CustomContext>(bot.api))
    .use(...routers, router)
    .use(composer.use(...composers));

  bot.catch(err => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error('Error in request:', e.description);
    } else if (e instanceof HttpError) {
      console.error('Could not contact Telegram:', e);
    } else {
      console.error('Unknown error:', e);
    }
  });

  return webhookCallback(bot, 'hono')(ctx, next);
});

app.onError((err, _ctx) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  const errorResponse = new Response('Unknown', {status: 401});
  return errorResponse;
});

export default app;
