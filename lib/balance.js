/**
 * dsh-session-cost — DeepSeek account balance query.
 *
 * Adapted from the reference plugin dsh-usage-stats' `balance.js`
 * (MIT © Ychris12138): DeepSeek exposes `GET {baseURL}/user/balance`, and the
 * CNY entry of `balance_infos` carries the remaining (`total_balance`),
 * granted (`granted_balance`) and topped-up (`topped_up_balance`) amounts.
 * The query is deliberately read-only and sends no secrets beyond the
 * provider's own API key.
 *
 * @module dsh-session-cost/balance
 */

/** Query the DeepSeek balance. Throws on transport/HTTP/parse errors. */
export async function queryDeepSeekBalance({ baseURL, apiKey, timeoutMs = 15000, fetchImpl = fetch }) {
	const url = new URL("/user/balance", baseURL).href;
	const response = await fetchImpl(url, {
		headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) throw providerError(`balance API returned HTTP ${response.status}`, response.status);
	let body;
	try {
		body = await response.json();
	} catch {
		throw providerError("balance API returned invalid JSON");
	}
	const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
	const info = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
	if (info === void 0) throw providerError("balance response is missing balance_infos");
	return {
		isAvailable: body?.is_available === true,
		currency: typeof info.currency === "string" ? info.currency : "CNY",
		total: info.total_balance ?? void 0,
		granted: info.granted_balance ?? void 0,
		toppedUp: info.topped_up_balance ?? void 0
	};
}

function providerError(message, httpStatus) {
	const error = new Error(message);
	error.providerStatus = httpStatus === 401 || httpStatus === 403
		? "unauthorized"
		: httpStatus === 429
			? "rate-limited"
			: httpStatus >= 500
				? "unavailable"
				: httpStatus !== void 0
					? "invalid-response"
					: "invalid-response";
	if (httpStatus !== void 0) error.httpStatus = httpStatus;
	return error;
}

/** Map any thrown error to a stable provider status string. */
export function balanceStatusOf(error) {
	if (error?.providerStatus !== void 0) return error.providerStatus;
	if (error?.name === "TimeoutError" || error?.name === "AbortError") return "unavailable";
	return "unavailable";
}
