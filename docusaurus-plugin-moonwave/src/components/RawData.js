import React from "react"

export default function RawData(props) {
  const { rawData } = props

  return (
    <pre>
      <code>{JSON.stringify(rawData, null, 2)}</code>
    </pre>
  )
}
