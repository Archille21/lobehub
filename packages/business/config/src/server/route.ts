// set timeout to about 5 minutes, and give 2s padding time
export const ASYNC_TASK_TIMEOUT = (60 * 5 - 2) * 1000;

// The lambda router's after() background jobs (video/image polling) need to
// outlive the request that scheduled them — without an explicit maxDuration
// the route runs under the platform default, which is normally far shorter
// than a multi-minute video generation task, so the poll loop gets killed
// mid-flight with no error ever thrown (see ASYNC_TASK_TIMEOUT above, which
// is what eventually surfaces the generic "task is timeout" to the client).
export const TRPC_ASYNC_MAX_DURATION: number = 300;
// export const TRPC_TOOLS_MAX_DURATION: number | undefined = undefined;

// export const WEBAPI_CHAT_MAX_DURATION: number = 300;
// export const WEBAPI_PLUGIN_GATEWAY_MAX_DURATION: number | undefined = undefined;
