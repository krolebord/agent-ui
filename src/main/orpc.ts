import { os } from "@orpc/server";
import type { Services } from "./create-services";

export const procedure = os.$context<Services>();
