// p-map 里三套顺序：返回值、mapper 的第二个参数、AggregateError.errors。
// 跑法：node repro/agg-order.mjs
import pMap from "../index.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const input = ["A", "B", "C", "D"];
const cost = {A: 200, B: 10, C: 150, D: 5};

for (const concurrency of [1, 2, 4, Infinity]) {
	const indexSeen = [];
	try {
		const values = await pMap(input, async (element, index) => {
			indexSeen.push(element + "@" + index);
			await sleep(cost[element]);
			return element.toLowerCase();
		}, {concurrency});
		console.log("c=" + String(concurrency).padEnd(8),
			"返回值顺序", values.join(","), "| mapper 收到的 index", indexSeen.join(","));
	} catch (error) {
		console.log("c=" + concurrency, "意外", error.message);
	}
}

for (const concurrency of [1, 2, 4, Infinity]) {
	try {
		await pMap(input, async element => {
			await sleep(cost[element]);
			throw new Error("e:" + element);
		}, {concurrency, stopOnError: true});
	} catch (error) {
		console.log("stopOnError=true c=" + String(concurrency).padEnd(8),
			"抛的是", error.constructor.name, "message", error.message);
	}
}

for (const concurrency of [2, 4, Infinity]) {
	try {
		await pMap(input, async element => {
			await sleep(cost[element]);
			throw new Error("e:" + element);
		}, {concurrency, stopOnError: false});
	} catch (error) {
		console.log("stopOnError=false c=" + String(concurrency).padEnd(8),
			"errors[] 顺序", error.errors.map(e => e.message.slice(2)).join(","),
			"| 个数", error.errors.length);
	}
}

const rejected = [Promise.reject(new Error("input 0")), 1, Promise.reject(new Error("input 2")), 3];
const mapped = [];
try {
	await pMap(rejected, async value => {
		mapped.push(value);
		await sleep(10);
		return value;
	}, {concurrency: 2, stopOnError: false});
} catch (error) {
	console.log("源自带 reject 时 errors[]", error.errors.map(e => e.message).join(","),
		"| 进 mapper 的值", mapped.join(","));
}
