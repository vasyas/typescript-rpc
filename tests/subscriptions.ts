import {assert} from "chai"
import {createTestClient, startTestServer, testClient, testServer} from "./testUtils.js"
import {adelay} from "../src/utils/promises.js"
import {CallOptions, RpcErrors} from "../src/index.js"
import {setTestWebSocketConnectionDelay} from "../src/client/WebSocketConnection.js"

describe("Subscriptions", () => {
  it("subscribe delivers data", async () => {
    const item = {r: "1"}

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    const client = await createTestClient<typeof services>()

    let receivedItem

    await client.test.item.subscribe((item) => {
      receivedItem = item
    })

    await adelay(50)
    assert.deepEqual(receivedItem, item)
  })

  it("disabled subscribe", async () => {
    const item = {r: "1"}

    const services = await startTestServer(
      {
        test: {
          item: async () => item,
        },
      },
      {
        subscriptions: false,
      },
    )

    const client = await createTestClient<typeof services>({
      subscriptions: false,
    })

    let receivedItem

    await client.test.item.subscribe((item) => {
      receivedItem = item
    })

    receivedItem = null

    item.r = "2"
    services.test.item.trigger()
    await adelay(20)

    assert.equal(receivedItem, null)
  })

  it("error in supplier breaks subscribe", async () => {
    const services = await startTestServer({
      item: async () => {
        throw new Error("AA")
      },
    })

    const client = await createTestClient<typeof services>()

    try {
      await client.item.subscribe(() => {})
      assert.fail("Error expected")
    } catch (e: any) {
      assert.equal(e.message, "AA")
    }
  })

  it("exception during subscribe do not create subscription", async () => {
    const services = {
      item: async () => {
        throw new Error()
      },
    }

    await startTestServer(services)

    const remote = await createTestClient<typeof services>()

    remote.item
      .subscribe(() => {})
      .catch((e: any) => {
        // ignored
      })

    // pause the socket so that the server doesn't get the unsubscribe message
    await adelay(20)

    assert.equal(0, testServer?._allSubscriptions().length)
  })

  it("2nd subscribe", async () => {
    const item = {r: "1"}

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    const remote = await createTestClient<typeof services>()

    let item1
    await remote.test.item.subscribe((item) => {
      item1 = item
    })

    await adelay(50)
    assert.deepEqual(item1, item)

    let item2
    await remote.test.item.subscribe((item) => {
      item2 = item
    })

    await adelay(50)
    assert.deepEqual(item2, item)

    // trigger sends item
    item.r = "2"
    services.test.item.trigger()
    await adelay(50)
    assert.deepEqual(item1, item)
    assert.deepEqual(item2, item)

    // a single subscription present on server
    assert.equal(testServer?._allSubscriptions().length, 1)
    assert.equal(testServer?._allSubscriptions()[0][0], "test/item")
  })

  it("subscribe use client cached value", async () => {
    const item = {r: "1"}

    const server = {
      test: {
        item: async () => item,
      },
    }

    await startTestServer(server)

    const client = await createTestClient<typeof server>()

    let item1
    await client.test.item.subscribe((item) => {
      item1 = item
    })

    await adelay(50)
    assert.deepEqual(item1, item)

    item.r = "2"

    let item2
    client.test.item.subscribe((item) => {
      item2 = item
    })

    // cached version should be delivered
    assert.deepEqual(item2, {r: "1"})

    await adelay(50)

    // and a new version after some time
    assert.deepEqual(item2, item)
  })

  // SWR
  it("out-of-subscriptions cache", async () => {
    const item = {r: "1"}

    const server = {
      test: {
        item: async () => item,
      },
    }

    await startTestServer(server)

    const cache = new Map()

    const client = await createTestClient<typeof server>({
      cache: {
        get(itemName: string, parameters: unknown[]): unknown {
          return cache.get(`${itemName}-${JSON.stringify(parameters)}`)
        },

        put(itemName: string, parameters: unknown[], value: unknown) {
          return cache.set(`${itemName}-${JSON.stringify(parameters)}`, value)
        },
      },
    })

    let item1
    const consumer = (item: any) => {
      item1 = item
    }

    await client.test.item.subscribe(consumer)

    await adelay(50)
    assert.deepEqual(item1, item)

    await client.test.item.unsubscribe(consumer)

    item.r = "2"

    let item2
    client.test.item.subscribe((item) => {
      item2 = item
    })

    // cached version should be delivered
    assert.deepEqual(item2, {r: "1"})

    await adelay(50)

    // and a new version after some time
    assert.deepEqual(item2, item)
  })

  it("unsubscribe topics on disconnect", async () => {
    const item = {r: "1"}

    const server = {
      testUnsub: {
        item: async () => item,
      },
    }

    await startTestServer(server)

    const remote = await createTestClient<typeof server>()

    await remote.testUnsub.item.subscribe(() => {})

    assert.equal(1, testServer?._allSubscriptions().length)

    await testClient!.close()

    await new Promise((r) => setTimeout(r, 50))

    // client's subscriptions are not removed intentionally not to lose existing handlers
    assert.equal(testClient?._allSubscriptions().length, 1)

    assert.equal(0, testServer?._allSubscriptions().length)
  })

  it("resubscribe on reconnect", async () => {
    const item = {r: "1"}

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    const remote = await createTestClient<typeof services>()

    let receivedItem

    await remote.test.item.subscribe((item) => {
      receivedItem = item
    })

    // first notification right after subscription
    await adelay(20)
    assert.deepEqual(receivedItem, item)

    // trigger sends item
    item.r = "2"
    services.test.item.trigger()
    await adelay(20)
    assert.deepEqual(receivedItem, item)

    // disconnect & resubscribe
    testClient?._webSocket()?.close()
    await adelay(50)

    // session should be re-subscribed, trigger should continue to send items
    item.r = "3"
    services.test.item.trigger()
    await adelay(20)
    assert.deepEqual(receivedItem, item)
  })

  it("double subscribe leaves session referenced on unsubscribe", async () => {
    const services = await startTestServer({
      item: async () => 1,
    })

    const remote = await createTestClient<typeof services>()

    const sub1 = () => {}
    const sub2 = () => {}

    await remote.item.subscribe(sub1)
    await adelay(20)

    assert.equal(1, testServer?._allSubscriptions().length)
    assert.equal(1, testClient?._allSubscriptions().length)

    await remote.item.subscribe(sub2)
    await adelay(20)

    assert.equal(1, testServer?._allSubscriptions().length)
    assert.equal(2, testClient?._allSubscriptions().length)

    await remote.item.unsubscribe(sub1)
    await adelay(100)
    assert.equal(1, testServer?._allSubscriptions().length)
    assert.equal(1, testClient?._allSubscriptions().length)

    await remote.item.unsubscribe(sub2)
    await adelay(100)
    assert.equal(0, testServer?._allSubscriptions().length)
    assert.equal(0, testClient?._allSubscriptions().length)
  })

  it("double subscribe single consumer", async () => {
    const services = await startTestServer({
      item: async () => 1,
    })

    const remote = await createTestClient<typeof services>()

    const sub = () => {}

    await remote.item.subscribe(sub)
    await adelay(20)
    assert.equal(1, testServer?._allSubscriptions().length)

    await remote.item.subscribe(sub)
    await adelay(20)
    assert.equal(1, testServer?._allSubscriptions().length)

    await remote.item.unsubscribe(sub)
    await adelay(20)
    assert.equal(1, testServer?._allSubscriptions().length)

    await remote.item.unsubscribe(sub)
    await adelay(20)
    assert.equal(0, testServer?._allSubscriptions().length)
  })

  it("double subscribe leaves session referenced on disconnect", async () => {
    const services = await startTestServer({
      item: async () => 1,
    })

    const remote = await createTestClient<typeof services>()

    const sub1 = () => {}
    const sub2 = () => {}

    await remote.item.subscribe(sub1)
    await adelay(20)
    assert.equal(1, testServer?._allSubscriptions().length)

    await remote.item.subscribe(sub2)
    await adelay(20)
    assert.equal(1, testServer?._allSubscriptions().length)

    await remote.item.unsubscribe(sub1)
    await adelay(100)

    await testClient?.close()
    await adelay(100)

    assert.equal(0, testServer?._allSubscriptions().length)
  })

  it("double subscribe unsubscribe bug", async () => {
    let delivered = null

    const services = await startTestServer({
      test: {
        item: async () => "ok-" + Date.now(),
      },
    })

    const client = await createTestClient<typeof services>()

    const sub1 = (r: string) => {
      delivered = r
    }

    const sub2 = () => {}

    await client.test.item.subscribe(sub1)

    await client.test.item.subscribe(sub2)

    assert.isOk(delivered)
    delivered = null

    await client.test.item.unsubscribe(sub2)

    services.test.item.trigger()

    await adelay(200)

    assert.isOk(delivered)
    delivered = null
  })

  it("unsubscribe before supply bug", async () => {
    const services = await startTestServer({
      item: async () => {
        await adelay(20)
        return 1
      },
    })

    const client = await createTestClient<typeof services>()

    const sub = () => {}
    client.item.subscribe(sub)

    await adelay(10)

    client.item.unsubscribe(sub)

    await adelay(30)

    assert.equal(testClient!._allSubscriptions().length, 0)
    assert.equal(testServer!._allSubscriptions().length, 0)
  })

  it("unsubscribe while disconnected bug", async () => {
    const services = await startTestServer({
      item: async () => {
        return 1
      },
    })

    // delay client connection open by 10ms
    delayWebsocketConnection(10)

    const client = await createTestClient<typeof services>()

    const sub = () => {}
    client.item.subscribe(sub)

    await adelay(10)

    client.item.unsubscribe(sub)

    await adelay(40)

    assert.equal(testClient!._allSubscriptions().length, 0)
    assert.equal(testServer!._allSubscriptions().length, 0)

    cancelWebsocketConnectionDelay()
  })

  it("skip unchanged data", async () => {
    const item = {r: "1"}

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    services.test.item.throttle({
      timeout: 0,
    })

    const client = await createTestClient<typeof services>()

    let receivedItem

    await client.test.item.subscribe(() => {
      receivedItem = item
    })

    await adelay(20)
    assert.deepEqual(receivedItem, item)
    receivedItem = null

    services.test.item.trigger()
    await adelay(20)
    assert.isNotOk(receivedItem)
  })

  it("per-subscribe timeout", async () => {
    const callTimeout = 200

    const services = await startTestServer({
      test: {
        async longOp() {
          await adelay(2 * callTimeout)
        },
      },
    })

    const client = await createTestClient<typeof services>({
      callTimeout: 4 * callTimeout,
    })

    try {
      await client.test.longOp.subscribe(() => {}, new CallOptions({timeout: callTimeout}))
      assert.fail()
    } catch (e: any) {
      assert.equal(e.code, RpcErrors.Timeout)
    }
  }).timeout(5000)

  it("missing update in case of concurrent subscribe/trigger", async () => {
    const delay = 50

    const services = await startTestServer({
      test: {
        async longOp() {
          await adelay(delay)
          return 1
        },
      },
    })

    const client = await createTestClient<typeof services>({
      callTimeout: 2 * delay,
      connectOnCreate: true,
    })

    let received = 0

    client.test.longOp.subscribe((val) => {
      console.log("got ", val)

      received = val
    })

    await adelay(20)
    services.test.longOp.trigger(undefined, 2)

    await adelay(2 * delay)

    assert.equal(received, 2)
  })

  // Currently not working, b/c paused is boolean
  // To implement it, need to replace it with counter
  it.skip("two concurrent subscribes and trigger", async () => {
    const delay = 50

    const services = await startTestServer({
      test: {
        async longOp() {
          await adelay(delay)
          return 1
        },
      },
    })

    const client = await createTestClient<typeof services>({
      callTimeout: 2 * delay,
    })

    let receivedA = 0
    let receivedB = 0

    client.test.longOp.subscribe((val) => {
      console.log("gotA", val)
      receivedA = val
    })

    client.test.longOp.subscribe((val) => {
      console.log("gotB", val)
      receivedB = val
    })

    await adelay(20)
    services.test.longOp.trigger(undefined, 2)

    await adelay(2 * delay)

    assert.equal(receivedA, 2)
    assert.equal(receivedB, 2)
  })

  it("clear queue on subscription failure", async () => {
    const delay = 50

    let invocation = 0
    const services = await startTestServer({
      test: {
        async longOp(): Promise<number> {
          await adelay(delay)
          if (invocation++ == 1) {
            throw new Error("AA")
          }

          return 1
        },
      },
    })

    const client = await createTestClient<typeof services>({
      callTimeout: 2 * delay,
    })

    let received = 0

    client.test.longOp.subscribe((val) => {
      received = val
    })

    await adelay(1.5 * delay)

    client.test.longOp
      .subscribe((val) => {
        received = val
      })
      .catch((e) => {
        // ok
      })

    await adelay(20)
    services.test.longOp.trigger(undefined, 2) // this should be skipped

    await adelay(1.5 * delay - 20)

    client.test.longOp.subscribe((val) => {
      received = val
    })

    await adelay(1.5 * delay)

    assert.equal(received, 1)
  })

  it("can subscribe while disconnected", async () => {
    const item = {r: "1"}

    delayWebsocketConnection(50)

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    const remote = await createTestClient<typeof services>()

    let receivedItem
    await remote.test.item.subscribe((item) => {
      receivedItem = item
    })

    assert.deepEqual(receivedItem, item)

    // trigger sends item
    item.r = "2"
    services.test.item.trigger()
    await adelay(60)
    assert.deepEqual(receivedItem, item)

    cancelWebsocketConnectionDelay()
  })

  it("connect during subscribe", async () => {
    const item = {r: "1"}

    delayWebsocketConnection(30)

    const services = await startTestServer({
      test: {
        item: async () => {
          await adelay(50)
          return item
        },
      },
    })

    const remote = await createTestClient<typeof services>()

    let receivedItem
    await remote.test.item.subscribe((item) => {
      receivedItem = item
    })

    assert.deepEqual(receivedItem, item)

    // trigger sends item
    item.r = "2"
    services.test.item.trigger()
    await adelay(100)
    assert.deepEqual(receivedItem, item)

    cancelWebsocketConnectionDelay()
  })

  it("disconnect during subscribe", async () => {
    const item = {r: "1"}

    const services = await startTestServer({
      test: {
        item: async () => item,
      },
    })

    const consume1 = await createTestClient<typeof services>({
      connectOnCreate: true,
    })

    let received = null

    // disconnect WS
    testClient!._webSocket()!.close()

    await consume1.test.item.subscribe((item) => {
      received = item
    })

    assert.deepEqual(received, item)

    item.r = "2"
    services.test.item.trigger()
    await adelay(100)

    // still getting the update b/c on WS reconnect client will resubscribe
    assert.deepEqual(received, item)
  })

  it("do not add subscriptions without connection", async () => {
    const item = {r: "1"}

    delayWebsocketConnection(100)

    const services = await startTestServer({
      test: {
        item: async () => {
          return item
        },
      },
    })

    const remote = await createTestClient<typeof services>()

    let receivedItem
    await remote.test.item.subscribe((item) => {
      receivedItem = item
    })

    assert.deepEqual(receivedItem, item)

    const length = testServer!._allSubscriptions().length

    assert.equal(length, 0)

    cancelWebsocketConnectionDelay()
  })
})

function delayWebsocketConnection(ms: number) {
  setTestWebSocketConnectionDelay(ms)
}

function cancelWebsocketConnectionDelay() {
  setTestWebSocketConnectionDelay(0)
}
