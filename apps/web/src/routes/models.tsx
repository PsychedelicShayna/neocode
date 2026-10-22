import { createFileRoute } from "@tanstack/react-router";
import { NeoPiModelsPage } from "../components/neopi/NeoPiModelsPage";
import { validateModelsSearch } from "../components/neopi/modelsPageState";

export const Route = createFileRoute("/models")({ validateSearch: validateModelsSearch, component: NeoPiModelsPage });
