import {createRpcClient, setLogger} from "@push-rpc/core"
import {createWebsocket} from "@push-rpc/websocket"
import {Client} from "./shared"

setLogger(console)
;(async () => {
  const local: Client = {
    getClientHello: async () => "Hello from client",
  }

  const {remote} = await createRpcClient(0, () => createWebsocket("ws://localhost:5555"), {
    local,
  })

  console.log("Client connected")

  const s = await remote.getServerHello()
  console.log(s)
})()
