import React from "react";

export function Button({ label = "Save", onClick }) {
  return (
    <button className="fx-button" type="button" onClick={onClick}>
      {label}
    </button>
  );
}
