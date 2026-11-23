import { useConnect } from "wagmi";
import {
  findQorexEip1193,
  isQorexInstalled,
  QOREX_DOWNLOAD_URLS,
} from "@qorechain/qorex-types";

export function useQoreX() {
  const { connectors, connectAsync } = useConnect();

  const connectQoreX = async () => {
    const qorexConnector =
      connectors.find((c) => c.id === "qorex") ??
      connectors.find((c) => c.name.toLowerCase().includes("qorex"));

    if (qorexConnector) {
      await connectAsync({ connector: qorexConnector });
      return;
    }

    const provider = findQorexEip1193() ?? window.qorex?.evm;
    if (provider) {
      await provider.request({ method: "eth_requestAccounts" });
      return;
    }

    if (!isQorexInstalled()) {
      console.warn(
        `QoreX wallet not detected. Install it here: ${QOREX_DOWNLOAD_URLS.chrome}`,
      );
    }
  };

  return { connectQoreX };
}