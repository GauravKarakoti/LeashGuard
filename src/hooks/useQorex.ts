import { useAccount, useConnect, useDisconnect } from "wagmi";
import { qorexConnector } from "@qorechain/qorex-types";

export function useQoreX() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  const connectQoreX = () => connect({ connector: qorexConnector() });

  return { address, isConnected, connectQoreX, disconnect };
}