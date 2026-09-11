import { create } from "zustand";

type UiState = {
  columnEditMode: boolean;
  setColumnEditMode: (open: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  columnEditMode: false,
  setColumnEditMode: (columnEditMode) => set({ columnEditMode }),
}));
