import React from "react";

export function Card({ title, children }) {
  return (
    <section className="fx-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
